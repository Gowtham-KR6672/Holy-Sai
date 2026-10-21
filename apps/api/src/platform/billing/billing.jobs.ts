import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { PlatformDb } from '../../tenancy/platform-db.service';
import { SubscriptionStatusService } from '../../tenancy/subscription-status.service';
import { TenancyService } from '../../tenancy/tenancy.service';
import { BillingService } from './billing.service';
import { PlatformMailer } from './platform-mailer.service';

/**
 * Renewal reminders (daily, 09:00 India time): 15, 7, 3 and 1 days before the end date, on the end date, when the
 * grace period starts, on its last day and when the school is blocked. Each one is sent once (ReminderLog), by email
 * to the billing contact and the school's admins, and as a notification inside the school.
 */
@Injectable()
export class BillingJobs {
  private readonly log = new Logger('BillingJobs');

  constructor(
    private readonly platform: PlatformDb,
    private readonly tenancy: TenancyService,
    private readonly status: SubscriptionStatusService,
    private readonly billing: BillingService,
    private readonly mailer: PlatformMailer,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('0 9 * * *', { timeZone: 'Asia/Kolkata', name: 'subscription-reminders' })
  async reminders() {
    const schools = await this.platform.workspace.findMany({ where: { status: 'active' } });
    for (const row of schools) {
      try {
        this.status.invalidate(row.id);
        const s = await this.status.forWorkspace(row.id);
        if (!s.endsOn || s.daysLeft === null) continue;
        const d = s.daysLeft;
        const before = [15, 7, 3, 1].filter((n) => n <= s.warningDays);
        let kind: string | null = null;
        let subject = '';
        let text = '';
        if (before.includes(d)) {
          kind = `before-${d}`;
          subject = `${row.name}: We School subscription ends in ${d} day${d === 1 ? '' : 's'}`;
          text = `The We School subscription of ${row.name} ends on ${s.endsOn}. Renew from Users & Settings › Subscription to keep using We School without interruption.`;
        } else if (d === 0) {
          kind = 'ends-today';
          subject = `${row.name}: We School subscription ends today`;
          text = `The subscription ends today (${s.endsOn}). After a ${s.graceDays}-day grace period, staff, parents and students will not be able to sign in until it is renewed.`;
        } else if (d === -1 && s.graceDays > 0) {
          kind = 'grace-started';
          subject = `${row.name}: We School subscription has ended — grace period until ${s.graceEndsOn}`;
          text = `The subscription ended on ${s.endsOn}. Everyone can still sign in until ${s.graceEndsOn}. Renew from Users & Settings › Subscription.`;
        } else if (d === -s.graceDays && s.graceDays > 1) {
          kind = 'grace-last-day';
          subject = `${row.name}: last day to renew We School`;
          text = `Today is the last day of the grace period. From tomorrow only Workspace Admins can sign in, to renew.`;
        } else if (d === -(s.graceDays + 1)) {
          kind = 'blocked';
          subject = `${row.name}: We School access is paused until renewal`;
          text = `The subscription and its grace period have ended. Staff, parents and students cannot sign in. Workspace Admins can sign in to renew; everything is kept.`;
        }
        if (!kind) continue;
        const logged = await this.platform.reminderLog.create({ data: { workspaceId: row.id, kind: `${kind}:${s.endsOn}` } }).catch(() => null);
        if (!logged) continue;
        const admins = await this.billing.schoolAdminEmails(row.id);
        await this.mailer.send([row.contactEmail ?? '', ...admins], subject, `${text}\n\nWe School`);
        const ws = await this.tenancy.byId(row.id);
        if (ws) {
          await this.tenancy.run(ws, () =>
            this.notifications.notifyPermission('subscription.manage', {
              category: d < 0 ? 'Critical' : 'Attention', topic: 'system', module: 'subscription', icon: 'alert',
              title: subject.replace(`${row.name}: `, ''), body: text, route: '/admin/subscription',
            }),
          );
        }
      } catch (err) {
        this.log.warn(`Reminder for ${row.code} not sent: ${(err as Error).message}`);
      }
    }
  }

  @Cron('0 */30 * * * *', { name: 'subscription-stale-checkouts' })
  async staleCheckouts() {
    await this.billing.expireStaleCheckouts().catch((err) => this.log.warn((err as Error).message));
  }
}
