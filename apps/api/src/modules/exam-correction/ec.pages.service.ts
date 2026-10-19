import { Injectable, StreamableFile } from '@nestjs/common';
import type { ExamCorrectionPage } from '@prisma/client';
import path from 'node:path';
import { badRequest, unavailable } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import type { AiPart } from '../ai/ai.providers';
import { StorageService, type UploadedFileLike } from '../operations/storage.service';
import { renderImage, renderPdf, renderer, renderProblem, rotatePdf, splitPdf } from './ec.render';
import { exifSwapsAxes, imageSize } from './ec.util';

/** Answer-sheet and question-paper file types. */
export const SHEET_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const DISPLAY_TYPES: Record<string, string> = { '.jpg': 'image/jpeg' };
export const MAX_SHEET_PAGES = 40;
export const MAX_FILE_MB = 30;
/** Largest image sent as-is (providers cap single images at 4–5 MB). */
const MAX_RAW_IMAGE = 4.5 * 1024 * 1024;

export interface PreparedPage {
  buffer: Buffer;
  mime: string;
  ext: string;
  fileName: string;
  width: number | null;
  height: number | null;
  warnings: string[];
}

/** Splits uploads into pages, stores them, serves page images and prepares pages for the AI. */
@Injectable()
export class EcPages {
  private rendering = new Map<string, Promise<{ key: string; mime: string } | null>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Checks uploaded files and splits PDFs into pages (in upload order). */
  async prepare(files: UploadedFileLike[], maxPages = MAX_SHEET_PAGES): Promise<PreparedPage[]> {
    const pages: PreparedPage[] = [];
    for (const f of files) {
      const name = path.basename(f.originalname || 'file');
      const ext = path.extname(name).toLowerCase();
      const mime = SHEET_TYPES[ext];
      if (!mime) throw badRequest(`${name}: use PDF, JPG, PNG or WebP files.`);
      if (!f.buffer?.length) throw badRequest(`${name} is empty.`);
      if (f.size > MAX_FILE_MB * 1024 * 1024) throw badRequest(`${name} is larger than ${MAX_FILE_MB} MB.`);
      if (mime === 'application/pdf') {
        if (f.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw badRequest(`${name} is not a valid PDF.`);
        let parts: Buffer[];
        try {
          parts = await splitPdf(f.buffer);
        } catch (err) {
          throw badRequest(`${name}: ${(err as Error).message}`);
        }
        parts.forEach((buffer, i) => pages.push({ buffer, mime, ext: '.pdf', fileName: parts.length > 1 ? `${name} p${i + 1}` : name, width: null, height: null, warnings: [] }));
      } else {
        const size = imageSize(f.buffer);
        if (!size) throw badRequest(`${name} is not a readable ${ext.slice(1).toUpperCase()} image.`);
        const swap = exifSwapsAxes(f.buffer);
        const width = swap ? size.height : size.width;
        const height = swap ? size.width : size.height;
        const warnings: string[] = [];
        if (Math.min(width, height) < 900) warnings.push('low resolution');
        pages.push({ buffer: f.buffer, mime, ext: ext === '.jpeg' ? '.jpg' : ext, fileName: name, width, height, warnings });
      }
      if (pages.length > maxPages) throw badRequest(`Up to ${maxPages} pages can be uploaded at once.`);
    }
    if (!pages.length) throw badRequest('Choose the PDF or the photos of the pages.');
    return pages;
  }

  /** Stores prepared pages for a sheet, numbered after any it already has. */
  async store(submissionId: string, pages: PreparedPage[]): Promise<ExamCorrectionPage[]> {
    const saved: string[] = [];
    try {
      const start = await this.prisma.examCorrectionPage.count({ where: { submissionId } });
      const rows: ExamCorrectionPage[] = [];
      for (const [i, p] of pages.entries()) {
        const stored = await this.storage.save({ originalname: `page-${start + i + 1}${p.ext}`, mimetype: p.mime, size: p.buffer.length, buffer: p.buffer }, 'exam-correction/sheets', SHEET_TYPES);
        saved.push(stored.key);
        rows.push(await this.prisma.examCorrectionPage.create({
          data: {
            submissionId, pageNo: start + i + 1, uploadedNo: start + i + 1, sourceKey: stored.key, sourceMime: p.mime, sizeBytes: stored.sizeBytes,
            sha256: stored.sha256, width: p.width, height: p.height, quality: { upload: p.warnings, reading: [], warnings: p.warnings },
          },
        }));
      }
      return rows;
    } catch (err) {
      await Promise.all(saved.map((k) => this.storage.remove(k)));
      throw err;
    }
  }

  /** Removes the stored files of pages (before their rows are deleted). */
  async removeFiles(pages: Pick<ExamCorrectionPage, 'sourceKey' | 'imageKey'>[]): Promise<void> {
    await Promise.all(pages.flatMap((p) => [this.storage.remove(p.sourceKey), this.storage.remove(p.imageKey)]));
  }

  // -------------------------------------------------------------------------
  // Viewer image
  // -------------------------------------------------------------------------

  /** The page as an image for the review screen (rendered from PDF or rotated on first request). */
  async image(page: ExamCorrectionPage): Promise<StreamableFile> {
    const { key, mime } = await this.displayImage(page);
    return this.storage.open(key, `page-${page.pageNo}${mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg'}`, mime);
  }

  private async displayImage(page: ExamCorrectionPage, again = true): Promise<{ key: string; mime: string }> {
    if (page.imageKey && page.imageMime) return { key: page.imageKey, mime: page.imageMime };
    const isPdf = page.sourceMime === 'application/pdf';
    if (!isPdf && !(page.rotation % 360) && page.sizeBytes <= 3 * 1024 * 1024) return { key: page.sourceKey, mime: page.sourceMime };
    if (!(await renderer())) {
      if (!isPdf) return { key: page.sourceKey, mime: page.sourceMime };
      throw unavailable(`This PDF page cannot be shown: ${renderProblem() ?? 'the page renderer is not available on this server'}.`);
    }
    let job = this.rendering.get(page.id);
    if (!job) {
      job = (async () => {
        const src = await this.storage.read(page.sourceKey);
        const r = isPdf ? await renderPdf(src, page.rotation, 1800) : await renderImage(src, page.rotation, 2200);
        const stored = await this.storage.save({ originalname: `page-${page.pageNo}.jpg`, mimetype: r.mime, size: r.data.length, buffer: r.data }, 'exam-correction/display', DISPLAY_TYPES);
        const updated = await this.prisma.examCorrectionPage.updateMany({ where: { id: page.id, rotation: page.rotation, imageKey: null }, data: { imageKey: stored.key, imageMime: r.mime, width: r.width, height: r.height } });
        if (!updated.count) {
          // Rotated (or rendered by another request) meanwhile: drop this copy.
          await this.storage.remove(stored.key);
          return null;
        }
        return { key: stored.key, mime: r.mime };
      })().finally(() => this.rendering.delete(page.id));
      this.rendering.set(page.id, job);
    }
    const done = await job;
    if (done) return done;
    const fresh = await this.prisma.examCorrectionPage.findUnique({ where: { id: page.id } });
    if (!fresh || !again) throw unavailable('The page changed while it was being prepared. Reload to see it.');
    return this.displayImage(fresh, false);
  }

  /** Turns a page clockwise; the viewer image is rebuilt on its next request. */
  async rotate(page: ExamCorrectionPage, degrees: number): Promise<number> {
    const rotation = (((page.rotation + degrees) % 360) + 360) % 360;
    await this.prisma.examCorrectionPage.update({ where: { id: page.id }, data: { rotation, imageKey: null, imageMime: null } });
    await this.storage.remove(page.imageKey);
    return rotation;
  }

  // -------------------------------------------------------------------------
  // AI input
  // -------------------------------------------------------------------------

  /**
   * A page as the provider takes it: providers that read PDFs (Claude, Gemini, OpenAI) get PDF pages as
   * documents (rotation applied in the PDF); everything else is sent as a JPEG, rotated, scaled to
   * `longEdge` and with the top blanked when `redact` > 0.
   */
  async aiPart(page: Pick<ExamCorrectionPage, 'sourceKey' | 'sourceMime' | 'rotation' | 'pageNo'>, o: { pdfOk: boolean; longEdge: number; redact: number; providerLabel: string }): Promise<{ part: AiPart; sentAs: 'pdf' | 'image' }> {
    const src = await this.storage.read(page.sourceKey);
    const canRender = !!(await renderer());
    if (page.sourceMime === 'application/pdf') {
      if (o.pdfOk && !o.redact) return { part: { type: 'pdf', data: (await rotatePdf(src, page.rotation)).toString('base64') }, sentAs: 'pdf' };
      if (!canRender) {
        throw new PermanentError(o.redact
          ? `Page ${page.pageNo} is a PDF page and the name area cannot be blanked on this server (${renderProblem()}). Turn off blanking or upload photos.`
          : `${o.providerLabel} reads images only, and this server cannot turn PDF pages into images (${renderProblem()}). Upload photos (JPG/PNG) instead, or use Claude, Gemini or OpenAI for Paper Correction.`);
      }
      const r = await renderPdf(src, page.rotation, o.longEdge, o.redact);
      return { part: { type: 'image', mediaType: r.mime, data: r.data.toString('base64') }, sentAs: 'image' };
    }
    if (canRender) {
      const r = await renderImage(src, page.rotation, o.longEdge, o.redact);
      return { part: { type: 'image', mediaType: r.mime, data: r.data.toString('base64') }, sentAs: 'image' };
    }
    if (page.rotation % 360 || o.redact) throw new PermanentError(`Page ${page.pageNo} cannot be rotated or blanked on this server (${renderProblem()}).`);
    if (src.length > MAX_RAW_IMAGE) throw new PermanentError(`Page ${page.pageNo} is larger than 4.5 MB and cannot be scaled down on this server (${renderProblem()}). Upload a smaller photo.`);
    return { part: { type: 'image', mediaType: page.sourceMime, data: src.toString('base64') }, sentAs: 'image' };
  }

  /** Pages of an uploaded question paper as AI parts (not stored). */
  async paperParts(pages: PreparedPage[], o: { pdfOk: boolean; longEdge: number; providerLabel: string }): Promise<AiPart[]> {
    const canRender = !!(await renderer());
    const out: AiPart[] = [];
    for (const p of pages) {
      if (p.mime === 'application/pdf') {
        if (o.pdfOk) out.push({ type: 'pdf', data: p.buffer.toString('base64') });
        else if (canRender) {
          const r = await renderPdf(p.buffer, 0, o.longEdge);
          out.push({ type: 'image', mediaType: r.mime, data: r.data.toString('base64') });
        } else throw badRequest(`${o.providerLabel} reads images only and this server cannot render PDF pages. Upload photos of the paper instead.`);
      } else if (canRender) {
        const r = await renderImage(p.buffer, 0, o.longEdge);
        out.push({ type: 'image', mediaType: r.mime, data: r.data.toString('base64') });
      } else {
        if (p.buffer.length > MAX_RAW_IMAGE) throw badRequest(`${p.fileName} is larger than 4.5 MB. Upload a smaller photo.`);
        out.push({ type: 'image', mediaType: p.mime, data: p.buffer.toString('base64') });
      }
    }
    return out;
  }
}

/** A failure that retrying cannot fix (bad file, unsupported provider, missing configuration). */
export class PermanentError extends Error {}
