import { Injectable } from '@nestjs/common';
import { PlatformDb } from './platform-db.service';
import { PlatformSettings } from './platform-settings.service';

/** none: no subscription yet (not enforced) · active · expiring (renewal reminders) · grace (ended, still open) ·
 *  expired (school users blocked; Workspace Admins can only renew) · suspended (set by a platform admin). */
export type SubscriptionState = 'none' | 'active' | 'expiring' | 'grace' | 'expired' | 'suspended';

export interface SubscriptionStatus {
  status: SubscriptionState;
  planCode: string | null;
  startsOn: string | null;
  endsOn: string | null;
  /** Days until the end date (0 = last day; negative = days since it ended). */
  daysLeft: number | null;
  graceEndsOn: string | null;
  warningDays: number;
  graceDays: number;
}

const DAY = 86_400_000;
const dayNumber = (key: string) => Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) / DAY;
const keyOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

/** Today's date (YYYY-MM-DD) in a time zone. */
export function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** A Date (DB date column) as YYYY-MM-DD. */
export const dateKey = (d: Date) => d.toISOString().slice(0, 10);
/** YYYY-MM-DD plus n days. */
export const addDays = (key: string, n: number) => keyOf(dayNumber(key) + n);
/** YYYY-MM-DD plus n months, minus one day (the last day of a period of n months starting on key). */
export function periodEnd(startKey: string, months: number): string {
  const [y, m, d] = [+startKey.slice(0, 4), +startKey.slice(5, 7) - 1, +startKey.slice(8, 10)];
  const target = new Date(Date.UTC(y, m + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const end = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay));
  return keyOf(end / DAY - 1);
}
export const daysBetween = (fromKey: string, toKey: string) => dayNumber(toKey) - dayNumber(fromKey);

/**
 * A school's subscription status, computed from its latest period end date in the school's time zone, cached for a
 * minute (billing changes clear the cache).
 */
@Injectable()
export class SubscriptionStatusService {
  private readonly cache = new Map<string, { at: number; value: SubscriptionStatus }>();

  constructor(
    private readonly platform: PlatformDb,
    private readonly settings: PlatformSettings,
  ) {}

  invalidate(workspaceId?: string) {
    if (workspaceId) this.cache.delete(workspaceId);
    else this.cache.clear();
  }

  async forWorkspace(workspaceId: string): Promise<SubscriptionStatus> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const value = await this.compute(workspaceId);
    this.cache.set(workspaceId, { at: Date.now(), value });
    return value;
  }

  private async compute(workspaceId: string): Promise<SubscriptionStatus> {
    const [ws, latest, warningDays, graceDays] = await Promise.all([
      this.platform.workspace.findUnique({ where: { id: workspaceId }, select: { status: true, timezone: true } }),
      this.platform.subscriptionPeriod.findFirst({ where: { workspaceId }, orderBy: [{ endsOn: 'desc' }, { createdAt: 'desc' }] }),
      this.settings.get<number>('subscription.warning_days'),
      this.settings.get<number>('subscription.grace_days'),
    ]);
    const base = { warningDays: Number(warningDays) || 15, graceDays: Number(graceDays) || 0 };
    if (!latest) {
      return { status: ws?.status === 'suspended' ? 'suspended' : 'none', planCode: null, startsOn: null, endsOn: null, daysLeft: null, graceEndsOn: null, ...base };
    }
    const endsOn = dateKey(latest.endsOn);
    const daysLeft = daysBetween(todayIn(ws?.timezone ?? 'Asia/Kolkata'), endsOn);
    const graceEndsOn = addDays(endsOn, base.graceDays);
    let status: SubscriptionState =
      daysLeft > base.warningDays ? 'active' : daysLeft >= 0 ? 'expiring' : daysLeft >= -base.graceDays ? 'grace' : 'expired';
    if (ws?.status === 'suspended') status = 'suspended';
    return { status, planCode: latest.planCode, startsOn: dateKey(latest.startsOn), endsOn, daysLeft, graceEndsOn, ...base };
  }
}
