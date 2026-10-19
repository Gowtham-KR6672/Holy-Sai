// Text from school documents for the Knowledge AI: PDF (text-based), Word (.docx) and plain text.
// Dependency-free and best-effort: scanned PDFs and unusual encodings yield little text, and the
// caller then falls back to an AI provider that can read the file (when one is connected).
import { inflateRawSync, inflateSync } from 'node:zlib';

/** Paragraph text; headings are prefixed with "## ". */
export function extractText(buf: Buffer, mimeType: string | null, name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  try {
    if (mimeType === 'application/pdf' || ext === 'pdf') return pdfText(buf);
    if (ext === 'docx' || mimeType?.includes('wordprocessingml')) return docxText(buf);
    if (ext === 'txt' || ext === 'md' || mimeType?.startsWith('text/')) return buf.toString('utf8');
  } catch {
    return '';
  }
  return '';
}

/** Share of letters, digits and spaces: low values mean the extraction produced noise. */
export function readable(text: string): boolean {
  const t = text.replace(/^## /gm, '').trim();
  if (t.length < 80) return false;
  const good = (t.match(/[A-Za-z0-9\s.,;:'"()\-₹%/ऀ-෿]/g) ?? []).length;
  const wordsFound = (t.match(/\b[a-zA-Z]{3,}\b/g) ?? []).length;
  return good / t.length > 0.85 && wordsFound >= 15;
}

// ---------------------------------------------------------------------------
// DOCX (zip → word/document.xml)
// ---------------------------------------------------------------------------

function unzipEntry(buf: Buffer, wanted: string): Buffer | null {
  // End of central directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const fileName = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (fileName === wanted) {
      const lNameLen = buf.readUInt16LE(local + 26);
      const lExtraLen = buf.readUInt16LE(local + 28);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      return method === 0 ? data : method === 8 ? inflateRawSync(data) : null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENTITIES[e]);

function docxText(buf: Buffer): string {
  const xml = unzipEntry(buf, 'word/document.xml')?.toString('utf8');
  if (!xml) return '';
  const out: string[] = [];
  for (const para of xml.split(/<\/w:p>/)) {
    const style = para.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? '';
    const text = unescapeXml(
      [...para.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((m) => (m[1] !== undefined ? m[1] : ' ')).join(''),
    ).trim();
    if (!text) continue;
    out.push(/^(heading|title)/i.test(style) ? `## ${text}` : text);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

interface PdfObject {
  dict: string;
  stream?: Buffer;
}

function decodeStream(dict: string, raw: Buffer): Buffer | undefined {
  if (/\/Subtype\s*\/Image/.test(dict)) return undefined;
  const filter = dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/)?.[1] ?? '';
  if (!filter) return raw;
  if (!/FlateDecode/.test(filter) || /DCT|JPX|CCITT|JBIG2|LZW|RunLength|ASCII85|ASCIIHex/.test(filter.replace('FlateDecode', ''))) return undefined;
  try {
    return inflateSync(raw);
  } catch {
    try {
      return inflateRawSync(raw.subarray(2));
    } catch {
      return undefined;
    }
  }
}

function parseObjects(buf: Buffer): Map<number, PdfObject> {
  const s = buf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = s.indexOf('endobj', start);
    if (end < 0) break;
    const body = s.slice(start, end);
    const si = body.search(/\bstream\r?\n/);
    if (si >= 0) {
      const dict = body.slice(0, si);
      const dataStart = start + si + body.slice(si).match(/^stream\r?\n/)![0].length;
      let dataEnd = s.indexOf('endstream', dataStart);
      if (dataEnd < 0 || dataEnd > end) dataEnd = end;
      let raw = buf.subarray(dataStart, dataEnd);
      while (raw.length && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)) raw = raw.subarray(0, raw.length - 1);
      objects.set(num, { dict, stream: decodeStream(dict, raw) });
    } else {
      objects.set(num, { dict: body });
    }
    re.lastIndex = end + 6;
  }
  // Objects packed in object streams (PDF 1.5+).
  for (const o of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict) || !o.stream) continue;
    const n = Number(o.dict.match(/\/N\s+(\d+)/)?.[1] ?? 0);
    const first = Number(o.dict.match(/\/First\s+(\d+)/)?.[1] ?? 0);
    const text = o.stream.toString('latin1');
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = header[i * 2];
      const off = header[i * 2 + 1];
      const next = i + 1 < n ? header[(i + 1) * 2 + 1] : text.length - first;
      if (!Number.isFinite(num) || objects.has(num)) continue;
      objects.set(num, { dict: text.slice(first + off, first + next) });
    }
  }
  return objects;
}

type CMap = { bytes: number; map: Map<number, string> };

function utf16(hex: string): string {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

function parseCMap(text: string): CMap {
  const map = new Map<number, string>();
  let bytes = 1;
  const range = text.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/);
  if (range && range[1].length >= 4) bytes = 2;
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(m[1], 16), utf16(m[2]));
      if (m[1].length >= 4) bytes = 2;
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (m[1].length >= 4) bytes = 2;
      if (hi - lo > 5000) continue;
      if (m[4] !== undefined) {
        const base = parseInt(m[4].slice(-4) || '0', 16);
        const prefix = utf16(m[4].slice(0, -4));
        for (let c = lo; c <= hi; c++) map.set(c, prefix + String.fromCharCode(base + (c - lo)));
      } else if (m[5] !== undefined) {
        const items = [...m[5].matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => utf16(x[1]));
        items.forEach((v, i) => map.set(lo + i, v));
      }
    }
  }
  return { bytes, map };
}

function literalBytes(lit: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < lit.length - 1; i++) {
    const c = lit[i];
    if (c !== '\\') {
      out.push(c.charCodeAt(0) & 0xff);
      continue;
    }
    const n = lit[++i];
    if (n === undefined) break;
    if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(lit[i + 1] ?? '')) oct += lit[++i];
      out.push(parseInt(oct, 8) & 0xff);
    } else if (n === 'n') out.push(10);
    else if (n === 'r') out.push(13);
    else if (n === 't') out.push(9);
    else if (n === 'b') out.push(8);
    else if (n === 'f') out.push(12);
    else if (n === '\r' || n === '\n') {
      if (n === '\r' && lit[i + 1] === '\n') i++;
    } else out.push(n.charCodeAt(0) & 0xff);
  }
  return out;
}

function decodeBytes(bytes: number[], cmap: CMap | undefined): string {
  if (!cmap || !cmap.map.size) return String.fromCharCode(...bytes.filter((b) => b >= 32 || b === 9));
  let out = '';
  for (let i = 0; i < bytes.length; i += cmap.bytes) {
    const code = cmap.bytes === 2 ? (bytes[i] << 8) | (bytes[i + 1] ?? 0) : bytes[i];
    out += cmap.map.get(code) ?? (cmap.bytes === 1 && code >= 32 ? String.fromCharCode(code) : '');
  }
  return out;
}

const TOKEN = /\((?:\\[\s\S]|[^\\)])*\)|<[0-9A-Fa-f\s]*>|\[|\]|-?\d*\.?\d+|\/[^\s/[\]()<>]+|[A-Za-z'"*]+/g;

function contentText(content: string, fonts: Map<string, CMap>): string {
  let out = '';
  for (const block of content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
    const ops: (string | number | (string | number)[])[] = [];
    let arr: (string | number)[] | null = null;
    let cmap: CMap | undefined;
    let lastY: number | null = null;
    const text = (v: string) => {
      if (v.startsWith('(')) return decodeBytes(literalBytes(v), cmap);
      const hex = v.slice(1, -1).replace(/\s/g, '');
      const bytes: number[] = [];
      for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
      if (!cmap && bytes.length % 2 === 0 && bytes.length >= 2 && bytes[0] === 0) {
        let u = '';
        for (let i = 0; i < bytes.length; i += 2) u += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
        return u;
      }
      return decodeBytes(bytes, cmap);
    };
    for (const m of block[1].matchAll(TOKEN)) {
      const t = m[0];
      if (t === '[') {
        arr = [];
        continue;
      }
      if (t === ']') {
        if (arr) ops.push(arr);
        arr = null;
        continue;
      }
      const isStr = t.startsWith('(') || (t.startsWith('<') && !t.startsWith('<<'));
      const isNum = /^-?\d*\.?\d+$/.test(t);
      if (arr) {
        arr.push(isNum ? Number(t) : t);
        continue;
      }
      if (isStr || isNum || t.startsWith('/')) {
        ops.push(isNum ? Number(t) : t);
        continue;
      }
      switch (t) {
        case 'Tf': {
          const name = ops[ops.length - 2];
          if (typeof name === 'string') cmap = fonts.get(name.slice(1));
          break;
        }
        case 'Tj':
        case "'":
        case '"': {
          const v = ops[ops.length - 1];
          if (t !== 'Tj') out += '\n';
          if (typeof v === 'string') out += text(v);
          break;
        }
        case 'TJ': {
          const v = ops[ops.length - 1];
          if (Array.isArray(v)) for (const x of v) out += typeof x === 'number' ? (x < -200 ? ' ' : '') : text(x);
          break;
        }
        case 'Td':
        case 'TD': {
          const ty = ops[ops.length - 1];
          out += typeof ty === 'number' && Math.abs(ty) > 0.1 ? '\n' : ' ';
          break;
        }
        case 'Tm': {
          const y = ops[ops.length - 1];
          if (typeof y === 'number') {
            if (lastY !== null && Math.abs(y - lastY) > 0.5) out += '\n';
            else if (lastY !== null) out += ' ';
            lastY = y;
          }
          break;
        }
        case 'T*':
          out += '\n';
          break;
        default:
          break;
      }
      ops.length = 0;
    }
    out += '\n';
  }
  return out;
}

function pdfText(buf: Buffer): string {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return '';
  const objects = parseObjects(buf);
  // Font object → ToUnicode map.
  const fontCmap = new Map<number, CMap>();
  for (const [num, o] of objects) {
    const ref = o.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    const cm = ref ? objects.get(Number(ref[1]))?.stream : undefined;
    if (cm) fontCmap.set(num, parseCMap(cm.toString('latin1')));
  }
  // Font resource name → map (names are usually consistent across a document's pages).
  const fonts = new Map<string, CMap>();
  const addPairs = (txt: string) => {
    for (const p of txt.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const cm = fontCmap.get(Number(p[2]));
      if (cm && !fonts.has(p[1])) fonts.set(p[1], cm);
    }
  };
  for (const o of objects.values()) {
    for (const f of o.dict.matchAll(/\/Font\s*(<<([\s\S]*?)>>|(\d+)\s+\d+\s+R)/g)) {
      if (f[2] !== undefined) addPairs(f[2]);
      else if (f[3]) addPairs(objects.get(Number(f[3]))?.dict ?? '');
    }
  }
  let text = '';
  for (const o of objects.values()) {
    if (!o.stream || /\/Type\s*\/(ObjStm|XRef|Metadata)|\/Subtype\s*\/(Image|XML)|\/Length1/.test(o.dict)) continue;
    const content = o.stream.toString('latin1');
    if (!/\bBT\b/.test(content) || !/T[jJ]/.test(content) || /begincmap/.test(content)) continue;
    text += contentText(content, fonts);
  }
  return text
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/-\n(?=[a-z])/g, '')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
