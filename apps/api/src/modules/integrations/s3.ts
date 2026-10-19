import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal S3 client (AWS Signature Version 4) for the 'storage' integration: Amazon S3 and S3-compatible services
 * such as Cloudflare R2. Only what file storage needs — put, get, delete — with no SDK dependency.
 */
export interface S3Config {
  bucket: string;
  /** e.g. "ap-south-1"; Cloudflare R2 uses "auto". */
  region: string;
  /** Custom endpoint for R2 / S3-compatible services, e.g. "https://<account>.r2.cloudflarestorage.com". Empty = AWS. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding used by SigV4 (encodeURIComponent leaves !'()* alone). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function s3Url(cfg: S3Config, key: string): URL {
  const keyPath = key.split('/').map(enc).join('/');
  if (cfg.endpoint) return new URL(`${cfg.endpoint.replace(/\/+$/, '')}/${enc(cfg.bucket)}/${keyPath}`); // path style
  return new URL(`https://${cfg.bucket}.s3.${cfg.region || 'us-east-1'}.amazonaws.com/${keyPath}`); // virtual-hosted style
}

/** Adds the SigV4 Authorization header. Pure, so it can be checked against AWS's published examples. */
export function signS3(
  cfg: Pick<S3Config, 'accessKeyId' | 'secretAccessKey' | 'region'>,
  req: { method: string; url: URL; headers: Record<string, string>; payloadHash: string; amzDate: string },
): string {
  const region = cfg.region || 'us-east-1';
  const date = req.amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: req.url.host };
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((k) => `${k}:${headers[k].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...req.url.searchParams.entries()].map(([k, v]) => `${enc(k)}=${enc(v)}`).sort().join('&');
  const canonicalRequest = [req.method, req.url.pathname, query, canonicalHeaders, signedHeaders, req.payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', req.amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, date), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** Error text from an S3 XML error body. */
async function s3Error(res: Response, what: string): Promise<Error> {
  const text = await res.text().catch(() => '');
  const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const message = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
  return new Error(`${what}: ${code ?? res.status}${message ? ` — ${message}` : ''}`);
}

async function s3Fetch(cfg: S3Config, method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Buffer, contentType?: string): Promise<Response> {
  const url = s3Url(cfg, key);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const payloadHash = sha256hex(body ?? '');
  const headers: Record<string, string> = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;
  headers.authorization = signS3(cfg, { method, url, headers, payloadHash, amzDate });
  return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(120_000) });
}

export async function s3Put(cfg: S3Config, key: string, body: Buffer, contentType: string): Promise<void> {
  const res = await s3Fetch(cfg, 'PUT', key, body, contentType);
  if (!res.ok) throw await s3Error(res, 'Upload failed');
}

/** The object as a web response (status 200), so callers can stream the body. */
export async function s3Get(cfg: S3Config, key: string): Promise<Response | null> {
  const res = await s3Fetch(cfg, 'GET', key);
  if (res.status === 404) return null;
  if (!res.ok) throw await s3Error(res, 'Download failed');
  return res;
}

export async function s3Delete(cfg: S3Config, key: string): Promise<void> {
  const res = await s3Fetch(cfg, 'DELETE', key);
  if (!res.ok && res.status !== 404) throw await s3Error(res, 'Delete failed');
}

/** S3 settings from the resolved 'storage' integration, or null for local disk. */
export function s3ConfigFrom(i: { provider: string | null; isEnabled: boolean; config: Record<string, string>; secrets: Record<string, string> }): S3Config | null {
  if (!i.isEnabled || !i.provider || i.provider === 'Local disk') return null;
  const r2 = i.provider === 'Cloudflare R2';
  return {
    bucket: i.config.bucket ?? '',
    region: i.config.region || (r2 ? 'auto' : 'us-east-1'),
    endpoint: i.config.endpoint || undefined,
    accessKeyId: i.config.accessKeyId ?? '',
    secretAccessKey: i.secrets.secretAccessKey ?? '',
  };
}
