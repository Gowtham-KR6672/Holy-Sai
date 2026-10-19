import type { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { notFound } from '../../common/errors';

// ---------------------------------------------------------------------------
// Catalogs and vocabularies (values match the web app's filters and badge maps)
// ---------------------------------------------------------------------------

/** Fee heads seeded into FinanceFeeHead (the UI picks from them but cannot create them). */
export const FEE_HEADS = ['Tuition', 'Transport', 'Activities', 'Books & Materials', 'Uniform', 'Trips'];

/** Expense categories / budget lines seeded into FinanceExpenseCategory. */
export const EXPENSE_CATEGORIES = [
  'Academics',
  'Administration',
  'Transport',
  'Facilities & Maintenance',
  'IT & Technology',
  'Sports & Activities',
  'Events & Celebrations',
  'Library',
  'Laboratories',
  'Marketing & Admissions',
  'Staff Development',
  'Utilities',
  'Housekeeping',
  'Security',
  'Health & Safety',
  'Printing & Stationery',
];

/** Staff groups (core Employee.category). */
export const EMPLOYEE_CATEGORIES = [
  'Leadership',
  'Teachers',
  'Reception & Admin',
  'Security',
  'Drivers & Attendants',
  'Housekeeping',
  'Lab Staff',
  'Library Staff',
];

export const TERMS = ['Term 1', 'Term 2', 'Term 3', 'Annual'];
export const STRUCTURE_STATUSES = ['Active', 'Draft', 'Archived'];
export const CONCESSION_TYPES = ['Sibling concession', 'Staff ward concession', 'Merit scholarship', 'Need-based support', 'Sports quota'];
/** Concession types shown on the Scholarships page. */
export const AWARD_TYPES = ['Merit scholarship', 'Need-based support', 'Sports quota'];
export const CLAIM_TYPES = ['Travel', 'Training', 'Supplies', 'Medical', 'Transport', 'Other'];
export const PAYMENT_METHODS = ['UPI', 'Card', 'Net Banking', 'Cash / DD'];
export const PAYMENT_STATUSES = ['Success', 'Initiated', 'Failed', 'Refunded'];
/** Instruments accepted at the counter. */
export const COUNTER_METHODS = ['Cash', 'UPI', 'Card', 'Net Banking', 'DD', 'Cheque'];
export const RECON_STATUSES = ['Matched', 'Unmatched', 'Exception', 'Resolved'];
export const OPEN_APPROVAL = ['Submitted', 'Under Review'];

/** Payment method group for an instrument (the Payments filter and method mix use four groups). */
export function methodOf(instrument: string): string {
  const i = instrument.trim().toLowerCase();
  if (['cash', 'dd', 'cheque', 'cash / dd', 'demand draft'].includes(i)) return 'Cash / DD';
  if (i === 'upi' || i === 'wallet') return 'UPI';
  if (i === 'net banking' || i === 'netbanking') return 'Net Banking';
  return 'Card';
}

// ---------------------------------------------------------------------------
// Numbers and money
// ---------------------------------------------------------------------------

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const num = (d: Prisma.Decimal | number | string | null | undefined): number => (d == null ? 0 : Number(d));
export const pct = (part: number, whole: number, digits = 1) => (whole ? Math.round((part / whole) * 100 * 10 ** digits) / 10 ** digits : 0);

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const inr = (n: number) => INR.format(n);

// ---------------------------------------------------------------------------
// Dates. Date-only columns are stored as UTC midnight; "today" is the school's date (Asia/Kolkata).
// ---------------------------------------------------------------------------

export const TZ = 'Asia/Kolkata';
const DAY = 86_400_000;

export const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
export const dateOnly = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
export const today = () => dateOnly(todayIso());
export const isoDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
export const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY);
/** The instant the school day (IST) began for a YYYY-MM-DD date. */
export const istStart = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00+05:30`);
/** The IST calendar date of a timestamp. */
export const istDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
/** YYYY-MM of a date-only value. */
export const monthOf = (d: Date) => d.toISOString().slice(0, 7);
/** YYYY-MM of a timestamp, in IST. */
export const istMonth = (d: Date) => istDate(d).slice(0, 7);
export const monthStart = (key: string) => dateOnly(`${key}-01`);
export const nextMonth = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
export const prevMonth = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (key: string) => MONTHS[Number(key.slice(5, 7)) - 1] ?? key;
export const monthYearLabel = (key: string) => `${monthLabel(key)} ${key.slice(0, 4)}`;

/** Normalises 'YYYY-MM', 'YYYY-MM-DD' or a Date into 'YYYY-MM'. */
export function monthKey(month: string | Date): string {
  if (month instanceof Date) return istMonth(month);
  return month.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Ledger arithmetic
// ---------------------------------------------------------------------------

export interface ChargeFigures {
  amount: number;
  concession: number;
  paid: number;
  balance: number;
  dueDate: Date;
}

/** Paid | Waived | Overdue | Partial | Pending for one charge. */
export function lineStatus(c: ChargeFigures, on: Date): string {
  if (c.balance <= 0.004) return c.paid > 0 ? 'Paid' : 'Waived';
  if (c.dueDate < on) return 'Overdue';
  return c.paid > 0 ? 'Partial' : 'Pending';
}

export interface AccountAgg {
  billed: number; // gross
  concession: number;
  paid: number;
  balance: number;
  overdue: number; // past due
  overdue30: number; // more than 30 days past due
  ageDays: number; // oldest overdue line, days past due
  nextDue: Date | null;
  nextDueAmount: number;
  lines: number;
}

export const emptyAgg = (): AccountAgg => ({ billed: 0, concession: 0, paid: 0, balance: 0, overdue: 0, overdue30: 0, ageDays: 0, nextDue: null, nextDueAmount: 0, lines: 0 });

export function addToAgg(a: AccountAgg, c: ChargeFigures, on: Date) {
  a.lines += 1;
  a.billed += c.amount;
  a.concession += c.concession;
  a.paid += c.paid;
  a.balance += c.balance;
  if (c.balance > 0.004) {
    if (c.dueDate < on) {
      const days = daysBetween(c.dueDate, on);
      a.overdue += c.balance;
      if (days > 30) a.overdue30 += c.balance;
      a.ageDays = Math.max(a.ageDays, days);
    } else if (!a.nextDue || c.dueDate < a.nextDue) {
      a.nextDue = c.dueDate;
      a.nextDueAmount = c.balance;
    } else if (a.nextDue.getTime() === c.dueDate.getTime()) {
      a.nextDueAmount += c.balance;
    }
  }
}

/** Overdue | Paid | Partial | Pending for a student account (No charges when nothing was raised). */
export function accountStatus(a: AccountAgg): string {
  if (!a.lines) return 'No charges';
  if (a.overdue > 0.004) return 'Overdue';
  if (a.balance <= 0.004) return 'Paid';
  return a.paid > 0 ? 'Partial' : 'Pending';
}

export function roundAgg(a: AccountAgg): AccountAgg {
  return { ...a, billed: r2(a.billed), concession: r2(a.concession), paid: r2(a.paid), balance: r2(a.balance), overdue: r2(a.overdue), overdue30: r2(a.overdue30), nextDueAmount: r2(a.nextDueAmount) };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** 404 for ids that are not uuids (instead of a database error). */
export function uuidOr404(id: string, what: string): string {
  if (!isUUID(id)) throw notFound(what);
  return id;
}

/** Sorts rows in memory by a key accessor. */
export function sortRows<T>(rows: T[], key: (r: T) => string | number | null | undefined, dir: 'asc' | 'desc' = 'asc'): T[] {
  const m = dir === 'desc' ? -1 : 1;
  return rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * m;
    return String(x).localeCompare(String(y), 'en', { numeric: true, sensitivity: 'base' }) * m;
  });
}

export const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? full;

/** CSV text (UTF-8 BOM so Excel shows ₹ correctly). */
export function toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '﻿' + [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))].join('\r\n');
}
