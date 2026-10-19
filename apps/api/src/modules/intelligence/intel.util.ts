// Shared helpers for the intelligence module: dates on the school clock, risk bands, CSV and ids.
import { StreamableFile } from '@nestjs/common';
import { notFound } from '../../common/errors';

export {
  addDays, asDate, dayKey, dayKeyOrNull, iso, loadTerms, mean, recentSchoolDays, round1, schoolToday, shortDate, termOf, weekdayOf,
  type Term,
} from '../academics/academics.util';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string | null | undefined): s is string => !!s && UUID.test(s);
/** Path ids must be uuids before they reach Postgres. */
export function assertUuid(id: string, what = 'Record'): string {
  if (!UUID.test(id)) throw notFound(what);
  return id;
}

export const DAY_MS = 86_400_000;

/** Risk bands, lowest to highest. */
export const RISK_LEVELS = ['On Track', 'Watch', 'Developing Risk', 'At Risk'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const riskRank = (r: string | null | undefined) => Math.max(0, RISK_LEVELS.indexOf((r ?? 'On Track') as RiskLevel));
export const maxRisk = (a: string, b: string) => (riskRank(a) >= riskRank(b) ? a : b);
/** The core Student.risk column keeps three values; "Watch" is stored there as "On Track". */
export const coreRisk = (band: string) => (band === 'Watch' ? 'On Track' : band);

export const STAGES = ['Signal', 'Teacher Review', 'Intervention', 'Action', 'Follow-up', 'Closed'];

export const pct = (n: number, of: number) => (of ? Math.round((100 * n) / of) : 0);
export const pct1 = (n: number, of: number) => (of ? Math.round((1000 * n) / of) / 10 : 0);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** CSV download (UTF-8 BOM so Excel shows ₹ and names correctly). */
export function csvFile(filename: string, columns: { key: string; label: string }[], rows: Record<string, unknown>[]): StreamableFile {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const text = '﻿' + [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))].join('\r\n') + '\r\n';
  return new StreamableFile(Buffer.from(text, 'utf8'), { type: 'text/csv; charset=utf-8', disposition: `attachment; filename="${filename}"` });
}

/** Lower-case words of a text without punctuation. */
export const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9ऀ-෿\s]/g, ' ').split(/\s+/).filter(Boolean);

/** Roman numerals I–XII as used for grades ("Grade VI"). */
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
/** A grade level mentioned in a question: "Grade 6", "grade VI", "class 9", "std 4", "6th". */
export function gradeIn(text: string): number | null {
  const m = text.match(/\b(?:grade|class|std|standard|year)\s*([0-9]{1,2}|[ivx]{1,4})\b/i) ?? text.match(/\b([0-9]{1,2})(?:st|nd|rd|th)\b/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const n = /^\d+$/.test(raw) ? Number(raw) : ROMAN[raw];
  return n && n >= 1 && n <= 12 ? n : null;
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
export const money = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** Lower-case form of a question used to count repeats. */
export const normalizeQuestion = (q: string) => q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** Rows grouped by student id, read back with a lookup function. */
export function byStudent<T extends { studentId: string }>(rows: T[]): (id: string) => T[] {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const list = m.get(r.studentId);
    if (list) list.push(r);
    else m.set(r.studentId, [r]);
  }
  return (id: string) => m.get(id) ?? [];
}
