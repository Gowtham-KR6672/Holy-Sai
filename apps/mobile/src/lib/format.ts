/** Formatting helpers — the same conventions as the web app (en-IN money, school time zone). */
import { LANGUAGES, translate, type LanguageId } from '@holysai/shared';
import { SCHOOL_TIMEZONE } from './config';

let lang: LanguageId = 'en';
let locale = 'en-IN';

/** Called by the I18n provider so dates use the chosen language's month names. */
export function setFormatLocale(id: LanguageId) {
  lang = id;
  locale = LANGUAGES.find((l) => l.id === id)?.locale ?? 'en-IN';
}

const tr = (text: string, vars?: Record<string, string | number>) => translate(lang, text, vars);

function toDate(d: string | Date): Date {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00`) : new Date(d);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function safe(fn: () => string, fallback: () => string) {
  try {
    return fn();
  } catch {
    return fallback();
  }
}

function indianGrouping(n: number, decimals = 0) {
  const neg = n < 0;
  const [int, frac] = Math.abs(n).toFixed(decimals).split('.');
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const body = rest ? `${rest},${last3}` : last3;
  return `${neg ? '-' : ''}${body}${frac && Number(frac) ? `.${frac}` : ''}`;
}

export const fmt = {
  n(v: number | string | null | undefined) {
    if (v == null || v === '') return '';
    return indianGrouping(Number(v));
  },
  compact(v: number) {
    const a = Math.abs(v);
    if (a >= 10000000) return (v / 10000000).toFixed(a % 10000000 === 0 ? 0 : 1) + 'Cr';
    if (a >= 100000) return (v / 100000).toFixed(a % 100000 === 0 ? 0 : 1) + 'L';
    if (a >= 1000) return (v / 1000).toFixed(a % 1000 === 0 ? 0 : 1) + 'k';
    return String(Math.round(v * 10) / 10);
  },
  money(v: number | string | null | undefined, opts: { compact?: boolean } = {}) {
    if (v == null || v === '') return '—';
    const n = Number(v);
    if (opts.compact) return '₹' + fmt.compact(n);
    return '₹' + indianGrouping(n, 2);
  },
  pct(v: number | null | undefined) {
    return v == null ? '—' : `${Math.round(v)}%`;
  },
  initials(name: string | null | undefined) {
    return String(name || '')
      .replace(/^(Dr|Mr|Ms|Mrs|Nurse)\.?\s+/i, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  },
  /** 14 Mar 2026 */
  date(d: string | Date | null | undefined) {
    if (!d) return '—';
    const dt = toDate(d);
    if (Number.isNaN(dt.getTime())) return '—';
    return safe(
      () => dt.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' }),
      () => `${String(dt.getDate()).padStart(2, '0')} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`,
    );
  },
  /** 14 Mar */
  dateShort(d: string | Date | null | undefined) {
    if (!d) return '—';
    const dt = toDate(d);
    if (Number.isNaN(dt.getTime())) return '—';
    return safe(
      () => dt.toLocaleDateString(locale, { day: '2-digit', month: 'short' }),
      () => `${String(dt.getDate()).padStart(2, '0')} ${MONTHS[dt.getMonth()]}`,
    );
  },
  /** 10:32 am (school time) */
  time(d: string | Date | null | undefined) {
    if (!d) return '—';
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return String(d).slice(0, 5);
    return safe(
      () => dt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: SCHOOL_TIMEZONE }),
      () => `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`,
    );
  },
  /** 17 Sep, 10:32 am */
  dateTime(d: string | Date | null | undefined) {
    if (!d) return '—';
    return `${fmt.dateShort(d)}, ${fmt.time(d)}`;
  },
  /** "5 min ago", "Yesterday", "12 Aug" */
  relative(d: string | Date | null | undefined) {
    if (!d) return '—';
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return '—';
    const diff = (Date.now() - dt.getTime()) / 1000;
    if (diff < 0) return fmt.dateTime(dt);
    if (diff < 60) return tr('Just now');
    if (diff < 3600) return tr('{n} min ago', { n: Math.floor(diff / 60) });
    if (dayKey(dt) === todayKey()) return fmt.time(dt);
    const y = new Date();
    y.setDate(y.getDate() - 1);
    if (dayKey(dt) === dayKey(y)) return tr('Yesterday');
    return fmt.dateShort(dt);
  },
  hhmm(t: string | null | undefined) {
    return t ? t.slice(0, 5) : '—';
  },
};

function dayKey(d: Date) {
  return safe(
    () => new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TIMEZONE }).format(d),
    () => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  );
}

/** Today as YYYY-MM-DD in school time. */
export function todayKey() {
  return dayKey(new Date());
}

export function addDays(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Good Morning" / "Good Afternoon" / "Good Evening" in school time. */
export function greetingKey() {
  const h = Number(
    safe(
      () => new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: SCHOOL_TIMEZONE }).format(new Date()),
      () => String(new Date().getHours()),
    ),
  );
  return h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
}

export function firstName(full: string | null | undefined) {
  const parts = String(full ?? '')
    .replace(/^(Dr|Mr|Ms|Mrs|Prof|Nurse)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean);
  return parts[0] ?? '';
}
