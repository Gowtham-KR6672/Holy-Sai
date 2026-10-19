/**
 * Native features of the app and how the original's web routes / bottom navigation map onto them.
 * The bottom tabs per role come from the shared BOTTOM_NAV (the original's mobile layout).
 */
import { ADMIN_ROLES, bottomNavFor, type IconName, type RoleKey } from '@holysai/shared';
import type { SessionUser } from '@/api/types';

export type FeatureKey =
  | 'command-center' | 'students' | 'notifications' | 'tracking' | 'teacher' | 'attendance' | 'copilot' | 'homework'
  | 'family' | 'family-track' | 'family-academics' | 'family-fees' | 'circulars' | 'messages' | 'ptm' | 'safety'
  | 'admissions' | 'fees' | 'tasks' | 'staff-self' | 'transport' | 'gate' | 'me' | 'my-ideas' | 'account' | 'more';

export interface Feature {
  key: FeatureKey;
  /** English label, translated with t(). */
  label: string;
  icon: IconName;
  /** Any one of these permissions shows the feature. */
  perm?: string[];
  hideRoles?: RoleKey[];
  /** Only for staff-side (school scope) roles. */
  schoolOnly?: boolean;
}

export const FEATURES: Record<FeatureKey, Feature> = {
  'command-center': { key: 'command-center', label: 'Command Center', icon: 'pulse', perm: ['dashboard.view', 'dashboard.group'], schoolOnly: true },
  students: { key: 'students', label: 'Students', icon: 'users', perm: ['students.read', 'students.read_assigned'] },
  notifications: { key: 'notifications', label: 'Notifications', icon: 'bell' },
  tracking: { key: 'tracking', label: 'Student Tracking', icon: 'mapPin', perm: ['tracking.read_all', 'tracking.read_assigned'] },
  teacher: { key: 'teacher', label: 'Teacher Dashboard', icon: 'bookOpen', perm: ['attendance.mark'], hideRoles: ADMIN_ROLES },
  attendance: { key: 'attendance', label: 'Attendance', icon: 'checkSquare', perm: ['attendance.mark', 'attendance.read'] },
  copilot: { key: 'copilot', label: 'AI Teacher Co-Pilot', icon: 'sparkle', perm: ['ai.use'] },
  homework: { key: 'homework', label: 'Homework', icon: 'edit', perm: ['academics.read'] },
  family: { key: 'family', label: 'Parent 360', icon: 'heart', perm: ['parent_portal.use'] },
  'family-track': { key: 'family-track', label: 'Track', icon: 'mapPin', perm: ['parent_portal.use'] },
  'family-academics': { key: 'family-academics', label: 'Academics', icon: 'bookOpen', perm: ['parent_portal.use'] },
  'family-fees': { key: 'family-fees', label: 'Fees', icon: 'wallet', perm: ['parent_portal.use'] },
  circulars: { key: 'circulars', label: 'Circulars', icon: 'megaphone', perm: ['parent_portal.use'] },
  messages: { key: 'messages', label: 'Messages', icon: 'message', perm: ['parent_portal.use'] },
  ptm: { key: 'ptm', label: 'Parent–teacher meetings', icon: 'calendar', perm: ['parent_portal.use'] },
  safety: { key: 'safety', label: 'Safety & Pickup', icon: 'shield', perm: ['parent_portal.use'] },
  admissions: { key: 'admissions', label: 'Admissions', icon: 'target', perm: ['admissions.read'] },
  fees: { key: 'fees', label: 'Fee Collection', icon: 'wallet', perm: ['finance.read'] },
  tasks: { key: 'tasks', label: 'My Tasks', icon: 'checkSquare' },
  'staff-self': { key: 'staff-self', label: 'Staff Self-Service', icon: 'idCard', perm: ['selfservice.use'] },
  transport: { key: 'transport', label: 'Transport', icon: 'bus', perm: ['transport.read'] },
  gate: { key: 'gate', label: 'Gate Entry/Exit', icon: 'scan', perm: ['safety.read'] },
  me: { key: 'me', label: 'My Profile', icon: 'user', perm: ['student_portal.use'] },
  'my-ideas': { key: 'my-ideas', label: 'My Ideas', icon: 'lightbulb', perm: ['student_portal.use'] },
  account: { key: 'account', label: 'My account', icon: 'settings' },
  more: { key: 'more', label: 'More', icon: 'menu' },
};

/** Every route file under src/app/(app)/(tabs). */
export const TAB_KEYS: FeatureKey[] = [
  'command-center', 'students', 'notifications', 'tracking', 'teacher', 'attendance', 'copilot', 'family', 'family-track',
  'family-academics', 'family-fees', 'admissions', 'fees', 'tasks', 'staff-self', 'transport', 'gate', 'me', 'more',
];

export function canUseFeature(user: SessionUser, key: FeatureKey): boolean {
  const f = FEATURES[key];
  if (f.hideRoles?.includes(user.role.key)) return false;
  if (f.schoolOnly && user.role.scope !== 'school') return false;
  if (!f.perm?.length) return true;
  return f.perm.some((p) => user.permissions.includes(p));
}

/** Maps a web route (from navigation, notifications or tasks) to a native feature, if there is one. */
export function featureForWebPath(path: string | null | undefined): FeatureKey | null {
  if (!path) return null;
  const [p, query = ''] = path.split('?');
  const qs = new URLSearchParamsLite(query);
  const seg = p.replace(/\/+$/, '') || '/';
  if (seg === '/parent-360' || seg.startsWith('/parent-360/')) {
    if (seg.startsWith('/parent-360/track')) return 'family-track';
    const tab = qs.get('tab');
    if (tab === 'track') return 'family-track';
    if (tab === 'academics') return 'family-academics';
    if (tab === 'fees') return 'family-fees';
    if (tab === 'safety') return 'safety';
    if (tab === 'more') return qs.get('compose') ? 'messages' : 'circulars';
    return 'family';
  }
  const table: Record<string, FeatureKey> = {
    '/command-center': 'command-center', '/overview': 'command-center', '/workforce': 'command-center',
    '/students': 'students', '/student-360': 'students', '/notifications': 'notifications', '/my-tasks': 'tasks', '/account': 'account',
    '/student-tracking': 'tracking', '/teacher': 'teacher', '/attendance': 'attendance', '/copilot': 'copilot', '/homework': 'homework',
    '/admissions': 'admissions', '/leads': 'admissions', '/enquiries': 'admissions', '/fees': 'fees', '/staff-self': 'staff-self',
    '/bus-tracking': 'transport', '/boarding': 'transport', '/gate-log': 'gate', '/my-profile': 'me', '/my-ideas': 'my-ideas',
  };
  return table[seg] ?? null;
}

/** A student id inside a web route such as /student-360/<id>. */
export function studentIdFromWebPath(path: string | null | undefined): string | null {
  const m = /^\/student-360\/([^/?#]+)/.exec(path ?? '');
  return m ? decodeURIComponent(m[1]) : null;
}

export interface TabDef {
  key: FeatureKey;
  /** English label from the original's bottom navigation. */
  label: string;
  icon: IconName;
  badge?: 'alerts' | 'tasks';
}

/** The bottom tabs for the signed-in role (the original's BOTTOM_NAV, minus anything the user cannot open). */
export function tabsFor(user: SessionUser): TabDef[] {
  const items = bottomNavFor(user.role.key, user.role.homeRoute);
  const out: TabDef[] = [];
  for (const it of items) {
    const key: FeatureKey | null = it.drawer ? 'more' : featureForWebPath(it.to);
    if (!key || out.some((x) => x.key === key)) continue;
    if (!canUseFeature(user, key)) continue;
    out.push({ key, label: it.label, icon: it.icon, badge: key === 'notifications' ? 'alerts' : key === 'tasks' ? 'tasks' : undefined });
  }
  // A role whose home has no native screen still gets a sensible first tab.
  if (!out.some((x) => x.key !== 'more' && x.key !== 'notifications' && x.key !== 'tasks')) {
    const fallback = (['command-center', 'fees', 'staff-self', 'me', 'family'] as FeatureKey[]).find((k) => canUseFeature(user, k));
    if (fallback) out.unshift({ key: fallback, label: 'Home', icon: 'home' });
  }
  if (!out.some((x) => x.key === 'notifications') && out.length < 5) {
    out.splice(Math.max(0, out.length - 1), 0, { key: 'notifications', label: 'Alerts', icon: 'bell', badge: 'alerts' });
  }
  if (!out.some((x) => x.key === 'more')) out.push({ key: 'more', label: 'More', icon: 'menu' });
  return out;
}

/** Tiny query-string reader (URLSearchParams is not complete on every React Native runtime). */
class URLSearchParamsLite {
  private map = new Map<string, string>();
  constructor(q: string) {
    for (const part of q.split('&')) {
      if (!part) continue;
      const [k, v = ''] = part.split('=');
      try {
        this.map.set(decodeURIComponent(k), decodeURIComponent(v.replace(/\+/g, ' ')));
      } catch {
        this.map.set(k, v);
      }
    }
  }
  get(k: string) {
    return this.map.get(k) ?? null;
  }
}

export function queryParam(path: string | null | undefined, key: string): string | null {
  if (!path || !path.includes('?')) return null;
  return new URLSearchParamsLite(path.split('?')[1] ?? '').get(key);
}
