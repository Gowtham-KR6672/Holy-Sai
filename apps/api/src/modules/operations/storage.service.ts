import { Injectable, Logger, StreamableFile } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { badRequest, notFound, unavailable } from '../../common/errors';
import { PerWorkspace } from '../../tenancy/context';
import { workspaceUploadDir } from '../../tenancy/uploads';
import { IntegrationsService } from '../integrations/integrations.service';
import { type S3Config, s3ConfigFrom, s3Delete, s3Get, s3Put } from '../integrations/s3';

/** Keys of files kept in the S3 / R2 bucket start with this prefix; other keys are on the local disk. */
const REMOTE = 's3:';

/** The parts of a multer file this service needs (memory storage). */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface StoredFile {
  /** Opaque key to keep on the record; pass it back to open(), read() or remove(). */
  key: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  originalName: string;
}

/** File types accepted for school and student documents. */
export const DOCUMENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * Private file storage behind the 'storage' integration: Local disk (under UPLOAD_DIR), Amazon S3 or Cloudflare R2.
 * Files get generated names — the original file name is never used in the path — and are served only through
 * authorised endpoints with open(). Each key remembers where its file lives, so files saved before a provider change
 * stay readable.
 *
 * Reusable by any module: save(file, 'folder') → { key, … }; open(key, downloadName) → StreamableFile;
 * read(key) → Buffer; remove(key).
 */
@Injectable()
export class StorageService {
  private readonly log = new Logger(StorageService.name);
  private readonly cached = new PerWorkspace<{ at: number; cfg: S3Config | null; provider: string | null } | null>(() => null);

  constructor(private readonly integrations: IntegrationsService) {}

  /** Each school's local files live in their own folder. */
  private root(): string {
    return workspaceUploadDir();
  }

  /** Absolute path of a key, refusing anything that escapes the upload folder. */
  private resolve(key: string): string {
    const root = this.root();
    const full = path.resolve(root, key);
    if (full !== root && !full.startsWith(root + path.sep)) throw badRequest('Invalid file reference');
    return full;
  }

  /** The bucket new files go to, or null for the local disk (settings re-read every 30 s). */
  private async target(): Promise<{ cfg: S3Config | null; provider: string | null }> {
    const hit = this.cached.get();
    if (hit && Date.now() - hit.at < 30_000) return hit;
    const i = await this.integrations.get('storage').catch(() => null);
    const fresh = { at: Date.now(), cfg: i ? s3ConfigFrom(i) : null, provider: i?.provider ?? null };
    this.cached.set(fresh);
    return fresh;
  }

  /** Bucket settings for a key that was saved remotely (whatever the current provider is). */
  private async bucketFor(): Promise<S3Config> {
    const i = await this.integrations.get('storage');
    const cfg = s3ConfigFrom({ ...i, isEnabled: true });
    if (!cfg?.bucket) throw unavailable('This file is kept in cloud storage, which is no longer configured (Integrations → File storage)');
    return cfg;
  }

  /**
   * Validates the type against an allow-list (extension and declared type) and stores the file.
   * `folder` groups files, e.g. "documents" or "documents/students".
   */
  async save(file: UploadedFileLike, folder: string, allowed: Record<string, string> = DOCUMENT_TYPES): Promise<StoredFile> {
    if (!file?.buffer?.length) throw badRequest('The file is empty');
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = allowed[ext];
    if (!mime) throw badRequest(`This file type is not accepted. Use ${[...new Set(Object.keys(allowed).map((e) => e.slice(1).toUpperCase()))].join(', ')}.`);
    if (ext === '.pdf' && file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw badRequest('This file is not a valid PDF');
    const target = await this.target();
    const safeFolder = folder.toLowerCase().replace(/[^a-z0-9/-]/g, '').replace(/\/+/g, '/').replace(/^\/|\/$/g, '') || 'files';
    const now = new Date();
    const key = [safeFolder, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), `${randomUUID()}${ext}`].join('/');
    let stored = key;
    if (target.cfg) {
      try {
        await s3Put(target.cfg, key, file.buffer, mime);
      } catch (err) {
        this.log.error(`${target.provider} upload failed: ${(err as Error).message}`);
        throw unavailable(`File storage (${target.provider}) is not reachable — the file was not saved. Check Integrations → File storage.`);
      }
      stored = REMOTE + key;
    } else {
      const full = this.resolve(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, file.buffer, { flag: 'wx' });
    }
    return {
      key: stored,
      sizeBytes: file.buffer.length,
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
      mimeType: mime,
      originalName: path.basename(file.originalname).slice(0, 200),
    };
  }

  /** A download response for a stored file (attachment with a safe file name). */
  async open(key: string, downloadName: string, mimeType?: string | null): Promise<StreamableFile> {
    const ascii = downloadName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim() || 'download';
    const disposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
    if (key.startsWith(REMOTE)) {
      const res = await s3Get(await this.bucketFor(), key.slice(REMOTE.length));
      if (!res?.body) throw notFound('File');
      return new StreamableFile(Readable.fromWeb(res.body as unknown as WebReadableStream), {
        type: mimeType || res.headers.get('content-type') || 'application/octet-stream',
        length: Number(res.headers.get('content-length')) || undefined,
        disposition,
      });
    }
    const full = this.resolve(key);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) throw notFound('File');
    return new StreamableFile(createReadStream(full), { type: mimeType || 'application/octet-stream', length: info.size, disposition });
  }

  /** The file's bytes (e.g. to send a scanned page to an AI model). */
  async read(key: string): Promise<Buffer> {
    if (key.startsWith(REMOTE)) {
      const res = await s3Get(await this.bucketFor(), key.slice(REMOTE.length));
      if (!res) throw notFound('File');
      return Buffer.from(await res.arrayBuffer());
    }
    const data = await readFile(this.resolve(key)).catch(() => null);
    if (!data) throw notFound('File');
    return data;
  }

  async remove(key: string | null | undefined): Promise<void> {
    if (!key) return;
    try {
      if (key.startsWith(REMOTE)) await s3Delete(await this.bucketFor(), key.slice(REMOTE.length));
      else await unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`Could not remove ${key}: ${(err as Error).message}`);
    }
  }
}
