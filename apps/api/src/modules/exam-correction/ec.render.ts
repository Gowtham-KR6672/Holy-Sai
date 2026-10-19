// Paper Correction — PDF splitting (pdf-lib, pure JS) and page rendering (pdf.js + @napi-rs/canvas, prebuilt
// binaries — no native build tools). Rendering is optional at run time: if the canvas binary cannot load,
// splitting still works and callers get a clear reason instead.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';

type Canvas = typeof import('@napi-rs/canvas');
interface PdfJs {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
}
interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage> }
interface PdfPage {
  rotate: number;
  getViewport(o: { scale: number; rotation?: number }): { width: number; height: number };
  render(o: Record<string, unknown>): { promise: Promise<void> };
}

// A real dynamic import (TypeScript would turn import() into require() under CommonJS; pdf.js is ESM only).
const importEsm = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;

let canvasLib: Canvas | null | undefined;
let pdfjs: PdfJs | null | undefined;
let problem: string | null = null;
let pdfjsDir = '';

/** Loads the renderer once; null (with renderProblem()) when this server cannot render. */
export async function renderer(): Promise<{ canvas: Canvas; pdfjs: PdfJs } | null> {
  if (canvasLib === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      canvasLib = require('@napi-rs/canvas') as Canvas;
    } catch (err) {
      canvasLib = null;
      problem = `The page renderer (@napi-rs/canvas) could not load on this server: ${(err as Error).message.split('\n')[0]}`;
    }
  }
  if (canvasLib && pdfjs === undefined) {
    try {
      const entry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
      pdfjsDir = path.resolve(path.dirname(entry), '../..');
      pdfjs = (await importEsm(pathToFileURL(entry).href)) as PdfJs;
    } catch (err) {
      pdfjs = null;
      problem = `The PDF renderer (pdfjs-dist) could not load on this server: ${(err as Error).message.split('\n')[0]}`;
    }
  }
  return canvasLib && pdfjs ? { canvas: canvasLib, pdfjs } : null;
}
export const renderProblem = () => problem;

/** pdf.js asset folders, as forward-slash paths ending in "/" (pdf.js requires the trailing slash). */
const asset = (name: string) => `${path.join(pdfjsDir, name).split(path.sep).join('/')}/`;

// ---------------------------------------------------------------------------
// PDF (pdf-lib, always available)
// ---------------------------------------------------------------------------

/** Splits a PDF into single-page PDFs, in order. */
export async function splitPdf(buf: Buffer): Promise<Buffer[]> {
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(buf, { updateMetadata: false });
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/encrypt/i.test(msg)) throw new Error('This PDF is password-protected. Save an unprotected copy and upload that.');
    throw new Error('This PDF could not be opened. Scan or export it again and retry.');
  }
  const n = src.getPageCount();
  if (!n) throw new Error('This PDF has no pages.');
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const one = await PDFDocument.create();
    const [page] = await one.copyPages(src, [i]);
    one.addPage(page);
    out.push(Buffer.from(await one.save()));
  }
  return out;
}

export async function pdfPageCount(buf: Buffer): Promise<number> {
  try {
    return (await PDFDocument.load(buf, { updateMetadata: false })).getPageCount();
  } catch (err) {
    if (/encrypt/i.test((err as Error).message ?? '')) throw new Error('This PDF is password-protected. Save an unprotected copy and upload that.');
    throw new Error('This PDF could not be opened. Scan or export it again and retry.');
  }
}

/** A single-page PDF turned clockwise by `rotation` degrees (added to any rotation it already has). */
export async function rotatePdf(buf: Buffer, rotation: number): Promise<Buffer> {
  if (!(rotation % 360)) return buf;
  const doc = await PDFDocument.load(buf, { updateMetadata: false });
  for (const p of doc.getPages()) p.setRotation(degrees((p.getRotation().angle + rotation) % 360));
  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------------------
// Rendering (needs the renderer)
// ---------------------------------------------------------------------------

export interface Rendered { data: Buffer; mime: 'image/jpeg'; width: number; height: number }

async function need() {
  const r = await renderer();
  if (!r) throw new Error(problem ?? 'Pages cannot be rendered on this server.');
  return r;
}

/** Renders page 1 of a PDF to JPEG with its longest edge at `longEdge` px, turned clockwise by `rotation`. */
export async function renderPdf(buf: Buffer, rotation: number, longEdge: number, redactTopPercent = 0): Promise<Rendered> {
  const { canvas, pdfjs: lib } = await need();
  const task = lib.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    standardFontDataUrl: asset('standard_fonts'),
    cMapUrl: asset('cmaps'),
    cMapPacked: true,
    wasmUrl: asset('wasm'),
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const rot = (((page.rotate + rotation) % 360) + 360) % 360;
    const base = page.getViewport({ scale: 1, rotation: rot });
    const scale = Math.min(6, longEdge / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale, rotation: rot });
    const c = canvas.createCanvas(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
    if (redactTopPercent > 0) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, Math.ceil((c.height * Math.min(50, redactTopPercent)) / 100));
    }
    return { data: await c.encode('jpeg', 88), mime: 'image/jpeg', width: c.width, height: c.height };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/**
 * Decodes a photo (JPEG/PNG/WebP; EXIF orientation is applied by the decoder), turns it clockwise by
 * `rotation`, scales the longest edge down to `longEdge`, optionally blanks the top, and encodes JPEG.
 */
export async function renderImage(buf: Buffer, rotation: number, longEdge: number, redactTopPercent = 0): Promise<Rendered> {
  const { canvas } = await need();
  const img = await canvas.loadImage(buf);
  const rot = (((rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  const scale = Math.min(1, longEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const swap = rot === 90 || rot === 270;
  const c = canvas.createCanvas(swap ? h : w, swap ? w : h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (redactTopPercent > 0) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, Math.ceil((c.height * Math.min(50, redactTopPercent)) / 100));
  }
  return { data: await c.encode('jpeg', 88), mime: 'image/jpeg', width: c.width, height: c.height };
}

// ---------------------------------------------------------------------------
// Sample page for the connection test (synthetic — no student data)
// ---------------------------------------------------------------------------

export const SAMPLE = {
  name: 'Sample Student',
  lines: ['1. Plants make their own food by photosynthesis.', 'They use sunlight, water and carbon dioxide', 'and give out oxygen.', '2. 60 km / 2 h = 30 km/h'],
};

/** A hand-drawn-looking sample answer page as JPEG (needs the renderer). */
export async function sampleImage(): Promise<Rendered> {
  const { canvas } = await need();
  const c = canvas.createCanvas(1100, 800);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fdfdf8';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#c9d8ee';
  for (let y = 140; y < 800; y += 70) {
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(1060, y);
    ctx.stroke();
  }
  ctx.fillStyle = '#1b2a6b';
  const write = (text: string, x: number, y: number, size: number) => {
    let cx = x;
    for (const ch of text) {
      ctx.save();
      ctx.font = `${size + ((ch.charCodeAt(0) * 7) % 3) - 1}px sans-serif`;
      ctx.translate(cx, y + ((ch.charCodeAt(0) * 13) % 5) - 2);
      ctx.rotate((((ch.charCodeAt(0) * 17) % 7) - 3) / 100);
      ctx.fillText(ch, 0, 0);
      cx += ctx.measureText(ch).width + 1;
      ctx.restore();
    }
  };
  write(`Name: ${SAMPLE.name}`, 50, 90, 38);
  SAMPLE.lines.forEach((l, i) => write(l, 60, 200 + i * 140, 40));
  return { data: await c.encode('jpeg', 88), mime: 'image/jpeg', width: c.width, height: c.height };
}

/** The same sample as a one-page PDF (works without the renderer, for providers that read PDFs). */
export async function samplePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaOblique);
  const page = doc.addPage([595, 420]);
  page.drawText(`Name: ${SAMPLE.name}`, { x: 40, y: 370, size: 20, font, color: rgb(0.1, 0.16, 0.42) });
  SAMPLE.lines.forEach((l, i) => page.drawText(l, { x: 40, y: 310 - i * 50, size: 18, font, color: rgb(0.1, 0.16, 0.42) }));
  return Buffer.from(await doc.save());
}
