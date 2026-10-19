// Paper Correction — pure helpers (no Nest, no database): roles, numbering, marks arithmetic, name and
// number checks, file-name matching, costs and CSV. Kept free of side effects so they can be tested alone.

export type ExamRole = 'admin' | 'coordinator' | 'teacher';

/** Role on the Paper Correction pages: admins manage settings, school-level staff coordinate, class staff mark. */
export function examRole(u: { permissions: Set<string>; scope: string }): ExamRole | null {
  if (u.permissions.has('settings.manage')) return 'admin';
  if (!u.permissions.has('assessments.manage')) return null;
  return u.scope === 'school' ? 'coordinator' : 'teacher';
}
export const isManager = (r: ExamRole | null) => r === 'admin' || r === 'coordinator';

export const QTYPES = ['short', 'long', 'math', 'science', 'diagram', 'essay', 'comprehension', 'translation'];
export const RESULTS = ['draft', 'reviewed', 'approved', 'published'] as const;
export type ResultsStatus = (typeof RESULTS)[number];
/** Allowed results transitions, matching the buttons on the examination page. */
export const RESULT_MOVES: Record<ResultsStatus, ResultsStatus[]> = {
  draft: ['reviewed'],
  reviewed: ['approved', 'draft'],
  approved: ['published', 'draft'],
  published: ['draft'],
};

// ---------------------------------------------------------------------------
// Numbers and marks
// ---------------------------------------------------------------------------

/** Rounds away floating-point noise (0.1 + 0.2 → 0.3). */
export const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
export const r2 = (n: number) => Math.round(n * 100) / 100;

/** True when `value` is a whole number of `step`s. */
export function isStep(value: number, step: number): boolean {
  if (!(step > 0)) return true;
  const k = value / step;
  return Math.abs(k - Math.round(k)) < 1e-6;
}

/** Nearest multiple of the step, clamped to 0..max. */
export function toStep(value: number, step: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  const s = step > 0 ? step : 0.5;
  const v = Math.round(Math.min(Math.max(value, 0), max) / s) * s;
  return r6(Math.min(Math.max(v, 0), max));
}

/** Accepts 2, "2", "1.5", "1½", " 2 marks" → number; anything else → null. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace('½', '.5').replace('¼', '.25').replace('¾', '.75').trim();
  const m = s.match(/^-?\d+(?:\.\d+)?|^-?\.\d+/);
  return m ? Number(m[0]) : null;
}

/** "Q1", "1.", "1(a)", "2 (ii)", "Question 3b" → "1", "1", "1a", "2b", "3b"; unrecognisable → null. */
export function normalizeNumber(raw: unknown): string | null {
  if (raw == null) return null;
  let s = String(raw).toLowerCase().trim();
  s = s.replace(/^(question|ques|qn|q|ans(wer)?)\s*[.:#-]?\s*/, '');
  const m = s.match(/^(\d{1,2})\s*[.)\]:-]?\s*(?:\(?\s*([a-z]{1,4})\s*\)?)?\s*[.)]?$/);
  if (!m) return null;
  const base = String(Number(m[1]));
  const sub = m[2];
  if (!sub) return base;
  if (sub.length === 1 && sub !== 'i' && sub !== 'v' && sub !== 'x') return base + sub;
  const roman: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
  if (roman[sub]) return base + String.fromCharCode(96 + roman[sub]);
  return sub.length === 1 ? base + sub : null;
}

/** Natural sort key: 2 → 200, 2a → 201, 10 → 1000. */
export function questionOrder(number: string): number {
  const m = number.match(/^(\d{1,2})([a-z]?)$/i);
  if (!m) return 9999;
  return Number(m[1]) * 100 + (m[2] ? m[2].toLowerCase().charCodeAt(0) - 96 : 0);
}

/** Maps a number the student (or the AI) wrote to an exam question: exact, else the parent question (1a → 1). */
export function matchQuestion(raw: unknown, numbers: string[]): string | null {
  const n = normalizeNumber(raw);
  if (!n) return null;
  if (numbers.includes(n)) return n;
  const parent = n.replace(/[a-z]$/, '');
  if (parent !== n && numbers.includes(parent)) return parent;
  return null;
}

export interface Criterion { id: string; name: string; max_marks: number; description?: string }

/**
 * Makes drafted criteria valid for a question: ids C1…, marks in steps of the increment, and the total equal
 * to the question's maximum (scaling and then fixing the remainder on the largest criterion).
 */
export function normalizeCriteria(raw: unknown, max: number, step: number): Criterion[] {
  const s = step > 0 ? step : 0.5;
  const list = (Array.isArray(raw) ? raw : []).map((c, i) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    return {
      id: String(o.id ?? '').trim().slice(0, 6),
      name: String(o.name ?? o.criterion ?? o.description ?? '').trim().slice(0, 300),
      max_marks: num(o.max_marks ?? o.marks ?? o.maximum_marks) ?? 0,
      description: String(o.description && o.name ? o.description : o.details ?? '').trim().slice(0, 500),
      i,
    };
  }).filter((c) => c.name && c.max_marks > 0);
  if (!list.length) return [{ id: 'C1', name: 'Correct answer', max_marks: max, description: '' }];
  const sum = list.reduce((a, c) => a + c.max_marks, 0);
  let out = list.map((c) => ({ ...c, max_marks: Math.max(s, Math.round((c.max_marks * max) / sum / s) * s) }));
  // Too many criteria for the marks available: keep the largest ones.
  while (out.length > 1 && out.length * s > max + 1e-9) {
    const smallest = out.reduce((a, c) => (c.max_marks < a.max_marks ? c : a));
    out = out.filter((c) => c !== smallest);
  }
  let diff = r6(max - out.reduce((a, c) => a + c.max_marks, 0));
  for (let guard = 0; Math.abs(diff) > 1e-9 && guard < 1000; guard++) {
    const sorted = [...out].sort((a, b) => b.max_marks - a.max_marks);
    const target = diff > 0 ? sorted[0] : sorted.find((c) => c.max_marks - s >= s - 1e-9);
    if (!target) break;
    target.max_marks = r6(target.max_marks + (diff > 0 ? s : -s));
    diff = r6(diff + (diff > 0 ? -s : s));
  }
  const seen = new Set<string>();
  return out.map((c, i) => {
    let id = /^[A-Za-z0-9]{1,6}$/.test(c.id) ? c.id.toUpperCase() : `C${i + 1}`;
    if (seen.has(id)) id = `C${i + 1}`;
    while (seen.has(id)) id = `${id}x`.slice(-6);
    seen.add(id);
    return { id, name: c.name, max_marks: r6(c.max_marks), description: c.description };
  });
}

/** Problems with a rubric that a teacher should fix before marking (shown on the question card). */
export function rubricProblems(
  q: { maxMarks: number; markIncrement: number },
  r: { criteria: Criterion[]; referenceAnswer: string; expectedConcepts: string[]; source: string; problems: string[] } | null,
): string[] {
  if (!r) return [];
  const out: string[] = [];
  const total = r6(r.criteria.reduce((a, c) => a + (Number(c.max_marks) || 0), 0));
  if (Math.abs(total - q.maxMarks) > 1e-6) out.push(`criteria add up to ${total} but the question is worth ${q.maxMarks}`);
  for (const c of r.criteria) if (!isStep(Number(c.max_marks), q.markIncrement)) out.push(`criterion ${c.id} (${c.max_marks}) is not in steps of ${q.markIncrement}`);
  if (!r.referenceAnswer.trim() && !r.expectedConcepts.length) out.push('add a reference answer or expected concepts so the answer can be compared');
  if (r.source === 'ai_draft') out.push(...r.problems);
  return out;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** The student's final numerical answer: the number after the last "=" or "Ans", else the last number written. */
export function finalNumber(text: string): number | null {
  const clean = text.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const pattern = /-?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?/g;
  const parts = clean.split(/(?:=|\bans(?:wer)?\b\s*[:.-]?|∴|therefore)/i);
  const pick = (s: string) => {
    const all = s.match(pattern);
    if (!all?.length) return null;
    const first = all[0];
    const [a, b] = first.split('/').map((x) => Number(x.trim()));
    return b !== undefined ? (b ? a / b : null) : a;
  };
  const fromTail = parts.length > 1 ? pick(parts[parts.length - 1]) : null;
  if (fromTail != null) return fromTail;
  const all = clean.match(pattern);
  if (!all?.length) return null;
  const last = all[all.length - 1];
  const [a, b] = last.split('/').map((x) => Number(x.trim()));
  return b !== undefined ? (b ? a / b : null) : a;
}

export interface Check { check: string; ok: boolean | null; detail: string }

/** Code checks of a numerical answer (final number within tolerance, unit present). */
export function numericChecks(text: string, expected: string | null, tolerance: number, unit: string | null): Check[] {
  if (!expected?.trim()) return [];
  const want = Number(expected);
  if (!Number.isFinite(want)) return [];
  const got = finalNumber(text);
  const out: Check[] = [];
  if (got == null) out.push({ check: 'numeric', ok: false, detail: `No final number found; expected ${expected}${unit ? ` ${unit}` : ''}` });
  else {
    const ok = Math.abs(got - want) <= Math.max(0, tolerance) + 1e-12;
    out.push({ check: 'numeric', ok, detail: ok ? `Final answer ${r6(got)} matches ${expected} (±${tolerance})` : `Final answer ${r6(got)} differs from ${expected} (±${tolerance})` });
  }
  if (unit?.trim()) {
    const has = text.toLowerCase().replace(/\s+/g, '').includes(unit.toLowerCase().replace(/\s+/g, ''));
    out.push({ check: 'unit', ok: has, detail: has ? `Unit ${unit} written` : `Unit ${unit} not found in the answer` });
  }
  return out;
}

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** True when the quoted evidence really appears in the student's answer (allowing for small transcription noise). */
export function evidenceFound(evidence: string, answer: string): boolean {
  const e = words(evidence);
  if (!e.length) return true;
  const a = new Set(words(answer));
  const hit = e.filter((w) => a.has(w)).length;
  return hit / e.length >= 0.6;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Compares the name read on the sheet with the chosen student's name. */
export function nameCheck(read: string | null | undefined, expected: string, redacted = false): { status: 'match' | 'differs' | 'none'; detail: string } {
  if (!read?.trim()) return { status: 'none', detail: redacted ? 'The name area was blanked before sending, so the name was not read.' : 'No name was found on the sheet.' };
  const r = words(read);
  const e = words(expected);
  const tokenOk = (t: string) => e.some((x) => x === t || (t.length === 1 && x.startsWith(t)) || (t.length >= 4 && x.length >= 4 && editDistance(t, x) <= 1) || (t.length >= 3 && x.startsWith(t)));
  const full = r.filter((t) => t.length > 1 && tokenOk(t)).length;
  const ok = r.length > 0 && full > 0 && r.every(tokenOk);
  return ok
    ? { status: 'match', detail: `Read "${read.trim()}" — matches ${expected}.` }
    : { status: 'differs', detail: `Read "${read.trim()}" — the chosen student is ${expected}.` };
}

/**
 * Finds the admission number in an uploaded file name (bulk upload), e.g. "HS-2026-1041.pdf" or
 * "hs-2026-1041_page2.jpg". The longest admission number found at word boundaries wins.
 */
export function matchAdmission(filename: string, admissionNos: string[]): string | null {
  const base = filename.replace(/\.[a-z0-9]+$/i, '').toUpperCase();
  let best: string | null = null;
  for (const no of admissionNos) {
    const n = no.toUpperCase().trim();
    if (!n) continue;
    let from = 0;
    for (;;) {
      const i = base.indexOf(n, from);
      if (i < 0) break;
      const before = base[i - 1];
      const after = base[i + n.length];
      const boundary = (c: string | undefined) => !c || !/[A-Z0-9]/.test(c);
      if (boundary(before) && (boundary(after) || (/\d$/.test(n) && /[A-Z]/.test(after ?? '')))) {
        if (!best || n.length > best.length) best = no;
        break;
      }
      from = i + 1;
    }
  }
  return best;
}

/** Natural order for file names: page2 before page10. */
export const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------------------
// AI replies
// ---------------------------------------------------------------------------

/** The first JSON object in an AI reply (fenced or bare); null when there is none or it does not parse. */
export function extractJson<T = Record<string, unknown>>(text: string): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const tries = [fenced, text];
  for (const t of tries) {
    if (!t) continue;
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(t.slice(start, end + 1)) as T;
    } catch {
      // Trailing commas are a common slip.
      try {
        return JSON.parse(t.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1')) as T;
      } catch {
        /* try the next candidate */
      }
    }
  }
  return null;
}

export const strList = (v: unknown, max = 20): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : [])
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? String((x as Record<string, unknown>).text ?? (x as Record<string, unknown>).name ?? '') : String(x ?? '')))
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((x) => x.slice(0, 400));

export const clamp01 = (v: unknown): number | null => {
  const n = num(v);
  if (n == null) return null;
  const x = n > 1 && n <= 100 ? n / 100 : n;
  return Math.min(1, Math.max(0, r2(x)));
};

// ---------------------------------------------------------------------------
// Cost estimate (US$ per million tokens, input/output). Unknown models count as 0 — the pages say "estimated".
// ---------------------------------------------------------------------------
const PRICES: [RegExp, number, number][] = [
  [/opus/, 5, 25],
  [/sonnet/, 3, 15],
  [/haiku/, 1, 5],
  [/flash-lite/, 0.1, 0.4],
  [/flash/, 0.3, 2.5],
  [/gemini.*pro/, 1.25, 10],
  [/gpt-4\.1-nano/, 0.1, 0.4],
  [/gpt-4\.1-mini/, 0.4, 1.6],
  [/gpt-4\.1/, 2, 8],
  [/gpt-4o-mini/, 0.15, 0.6],
  [/gpt-4o/, 2.5, 10],
  [/gpt-5.*nano/, 0.05, 0.4],
  [/gpt-5.*mini/, 0.25, 2],
  [/gpt-5/, 1.25, 10],
  [/llama-4-scout/, 0.11, 0.34],
  [/llama-4-maverick/, 0.2, 0.6],
  [/llama-3\.3-70b/, 0.59, 0.79],
];
export function estimateCostUsd(model: string | null | undefined, input: number | null | undefined, output: number | null | undefined): number {
  const m = (model ?? '').toLowerCase();
  const p = PRICES.find(([re]) => re.test(m));
  if (!p) return 0;
  return ((input ?? 0) * p[1] + (output ?? 0) * p[2]) / 1_000_000;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
/** One CSV cell, quoted, with spreadsheet formula injection neutralised. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: unknown[]) => cells.map(csvCell).join(',');

/** Runs `fn` over items with at most `limit` running at once. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Width and height from an image header (JPEG, PNG, WebP) without decoding it. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    return null;
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** EXIF orientation 5–8 swaps width and height. */
export function exifSwapsAxes(buf: Buffer): boolean {
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return false;
  const i = buf.indexOf(Buffer.from('Exif\0\0', 'latin1'));
  if (i < 0 || i > 65536) return false;
  const t = i + 6;
  const le = buf.toString('latin1', t, t + 2) === 'II';
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  try {
    const ifd = t + u32(t + 4);
    const n = u16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (u16(e) === 0x0112) return u16(e + 8) >= 5 && u16(e + 8) <= 8;
    }
  } catch {
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sheet status and processing settings
// ---------------------------------------------------------------------------

/** How much to send per call and at what resolution, by the "effort" setting. */
export const EFFORTS = {
  low: { longEdge: 1280, pagesPerCall: 4, readTokens: 6000, markTokens: 1200, rubricTokens: 1500, paperTokens: 6000 },
  medium: { longEdge: 1600, pagesPerCall: 4, readTokens: 8000, markTokens: 1600, rubricTokens: 2000, paperTokens: 8000 },
  high: { longEdge: 2000, pagesPerCall: 3, readTokens: 12000, markTokens: 2500, rubricTokens: 3000, paperTokens: 12000 },
} as const;
export type Effort = keyof typeof EFFORTS;
export const effortOf = (v: string): (typeof EFFORTS)[Effort] => EFFORTS[(v in EFFORTS ? v : 'medium') as Effort];

/** Providers whose adapters accept PDF documents; the others are sent rendered page images. */
export const PDF_PROVIDERS = new Set(['claude', 'gemini', 'openai']);

/** Groq serves text-only and vision models; only the vision ones can read a page. */
export function visionProblem(provider: { provider: string; label: string; model: string; visionModel: string | null }): string | null {
  if (provider.provider !== 'groq') return null;
  const m = provider.visionModel ?? provider.model;
  return /llama-4|vision|scout|maverick|llava|gemma-3/i.test(m)
    ? null
    : `${provider.label} is set to ${m}, which cannot read images. Set a vision model for it (e.g. meta-llama/llama-4-scout-17b-16e-instruct) on the AI Providers page.`;
}

/** Flags added by teachers or after teacher actions (kept when a sheet is read again). */
export const FLAG_REVIEW = 'Review requested';
export const FLAG_TEXT_CHANGED = 'Transcription changed after the AI marked it — use Re-evaluate to mark the corrected text.';
export const FLAG_REREAD = 'Read again after a teacher entered marks — check the marks still fit the answer.';
export const isTeacherFlag = (f: string) => f.startsWith(FLAG_REVIEW) || f === FLAG_TEXT_CHANGED || f === FLAG_REREAD;

export interface SheetState {
  job: { kind: string; status: string; error: string | null } | null;
  hasReading: boolean;
  questionCount: number;
  answers: { markStatus: string }[];
  identityVerified: boolean;
  nameStatus: string | null;
  failedMarks: string[];
}

/** The sheet's status (as the pages' badges show it) and a note when it needs attention. */
export function sheetStatus(i: SheetState): { status: string; note: string } {
  if (i.job && (i.job.status === 'queued' || i.job.status === 'running')) return { status: i.job.kind === 'Marking' ? 'evaluating' : 'extracting', note: '' };
  if (!i.hasReading) return i.job?.status === 'failed' ? { status: 'failed', note: `Reading failed: ${i.job.error ?? 'unknown error'}` } : { status: 'uploaded', note: '' };
  const approved = i.answers.filter((a) => a.markStatus === 'approved').length;
  if (i.questionCount > 0 && approved >= i.questionCount && i.identityVerified) return { status: 'approved', note: '' };
  const notes: string[] = [];
  if (i.nameStatus === 'differs' && !i.identityVerified) notes.push('The name on the sheet differs from the chosen student');
  if (i.failedMarks.length) notes.push(`Q${i.failedMarks.join(', Q')} could not be marked by the AI`);
  if (i.job?.status === 'failed') notes.push(`Last job failed: ${i.job.error ?? 'unknown error'}`);
  if (i.questionCount > 0 && !i.answers.length) notes.push('No answers were found on the sheet');
  if (notes.length) return { status: 'needs_attention', note: `${notes.join('. ')}.` };
  if (approved > 0 || i.answers.some((a) => a.markStatus === 'reviewed')) return { status: 'reviewed', note: '' };
  if (i.answers.length > 0 && !i.answers.some((a) => a.markStatus === 'pending')) return { status: 'evaluated', note: '' };
  return { status: 'extracted', note: '' };
}

/** Largest reply budget to ask a provider for (Groq vision models stop at 8,192 tokens; GPT-4o at 16,384). */
export const replyCap = (provider: string | null | undefined) => (provider === 'groq' ? 8000 : provider === 'openai' || provider === 'openrouter' ? 16000 : 32000);
export const outputCap = (provider: string | undefined, tokens: number) => Math.min(tokens, replyCap(provider));
