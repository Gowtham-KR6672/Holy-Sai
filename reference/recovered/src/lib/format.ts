/** Formatting helpers (ported from the wireframe's HS.fmt, en-IN conventions). */

export const fmt = {
  n(v: number | string | null | undefined) {
    return v == null || v === '' ? '' : Number(v).toLocaleString('en-IN');
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
    return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  },
  pct(v: number | null | undefined, d?: number) {
    if (v == null) return '—';
    return (d != null ? Number(v).toFixed(d) : Math.round(v)) + '%';
  },
  initials(name: string) {
    return String(name || '')
      .replace(/^(Dr|Mr|Ms|Mrs|Nurse)\.?\s+/i, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  },
  /** 14 Mar 2015 */
  date(d: string | Date | null | undefined) {
    if (!d) return '—';
    const dt = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00') : new Date(d);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  },
  /** 14 Mar */
  dateShort(d: string | Date | null | undefined) {
    if (!d) return '—';
    const dt = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00') : new Date(d);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  },
  /** 10:32 (school timezone) */
  time(d: string | Date | null | undefined) {
    if (!d) return '—';
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return String(d).slice(0, 5);
    return dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  },
  /** 17 Sep, 10:32 am */
  dateTime(d: string | Date | null | undefined) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  },
  /** "5 min ago", "Yesterday", "12 Aug" */
  relative(d: string | Date | null | undefined) {
    if (!d) return '—';
    const dt = new Date(d);
    const diff = (Date.now() - dt.getTime()) / 1000;
    if (diff < 0) return fmt.dateTime(dt);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    const today = todayKey();
    const key = dayKey(dt);
    if (key === today) return fmt.time(dt);
    const y = new Date();
    y.setDate(y.getDate() - 1);
    if (key === dayKey(y)) return 'Yesterday';
    return fmt.dateShort(dt);
  },
  /** Seconds → "3 min 42 s" */
  duration(mins: number) {
    if (mins < 60) return `${Math.round(mins)} min`;
    return `${Math.floor(mins / 60)} h ${Math.round(mins % 60)} min`;
  },
  coord(v: number | null | undefined) {
    return v == null ? '—' : Number(v).toFixed(4);
  },
};

function dayKey(d: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}
export function todayKey() {
  return dayKey(new Date());
}

export function gradeLabel(grade?: string | null, section?: string | null) {
  if (!grade) return '—';
  return `${grade}${section ?? ''}`;
}

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}
