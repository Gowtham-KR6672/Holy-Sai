/** Geometry and school-clock helpers for transport and tracking. */

export interface LatLng {
  latitude: number;
  longitude: number;
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance in metres from a point to the segment a–b (local equirectangular projection; fine at city scale). */
export function distanceToSegmentM(p: LatLng, a: LatLng, b: LatLng): number {
  const k = Math.cos(rad(p.latitude));
  const ax = (a.longitude - p.longitude) * k;
  const ay = a.latitude - p.latitude;
  const bx = (b.longitude - p.longitude) * k;
  const by = b.latitude - p.latitude;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy) * (Math.PI / 180) * R;
}

/** Shortest distance in metres from a point to a polyline (or to its only point). */
export function distanceToPathM(p: LatLng, path: LatLng[]): number | null {
  if (!path.length) return null;
  if (path.length === 1) return distanceM(p, path[0]);
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) best = Math.min(best, distanceToSegmentM(p, path[i], path[i + 1]));
  return best;
}

/** Length of a polyline in metres. */
export function pathLengthM(path: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distanceM(path[i - 1], path[i]);
  return total;
}

export const hasPoint = <T extends { latitude: number | null; longitude: number | null }>(p: T): p is T & LatLng =>
  p.latitude != null && p.longitude != null && Number.isFinite(p.latitude) && Number.isFinite(p.longitude);

// ---------------------------------------------------------------------------
// School clock (timezone-aware dates and times)
// ---------------------------------------------------------------------------

function parts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}

/** YYYY-MM-DD of an instant in the school timezone. */
export function dateKey(d: Date, tz: string): string {
  const p = parts(d, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Minutes since local midnight of an instant in the school timezone. */
export function minutesOfDay(d: Date, tz: string): number {
  const p = parts(d, tz);
  return p.h * 60 + p.mi;
}

/** HH:MM of an instant in the school timezone. */
export function hhmm(d: Date, tz: string): string {
  const p = parts(d, tz);
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

/** Offset (ms) of the timezone from UTC at an instant. */
function offsetMs(d: Date, tz: string): number {
  const p = parts(d, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - (d.getTime() - d.getMilliseconds());
}

/** The UTC instant of a local date + minutes-of-day in the school timezone. */
export function localInstant(day: string, minutes: number, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60));
  return new Date(guess.getTime() - offsetMs(guess, tz));
}

/** A @db.Date value for a local date key. */
export const dbDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
export const dbDateKey = (d: Date) => d.toISOString().slice(0, 10);

/** "07:40" → minutes since midnight; null when not a time. */
export function timeToMinutes(t: string | null | undefined): number | null {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export const minutesToTime = (n: number) => {
  const v = ((Math.round(n) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};

/** "Grade 5" → "5", "Class 10" → "10", "LKG" → "LKG": the short grade the pages print before the section. */
export const gradeLabel = (className: string | null | undefined) => (className ? className.replace(/^(grade|class|std\.?|year)\s*/i, '').trim() || className : null);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export const round = (n: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** A campus filter from the query string: a uuid, else none ("all" or junk never reaches Prisma). */
export const campusParam = (v?: string | null) => (v && isUuid(v) ? v : undefined);
