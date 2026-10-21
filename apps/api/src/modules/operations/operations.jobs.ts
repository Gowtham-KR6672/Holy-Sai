import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { can, type AuthUser } from '../../common/auth-user';
import { like } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SearchService, type SearchHit } from '../search/search.service';
import { DUE_SOON_DAYS } from './compliance.controller';
import { addDays, OpsContext, today, TZ } from './ops.util';
import { ForEachWorkspace } from '../../tenancy/for-each-workspace.decorator';

/** Global search entries for operations records, and the daily reminders (due dates, service dates, expiries). */
@Injectable()
export class OperationsJobs implements OnModuleInit {
  private readonly log = new Logger(OperationsJobs.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ctx: OpsContext,
    private readonly notifications: NotificationsService,
    private readonly search: SearchService,
  ) {}

  onModuleInit() {
    this.search.register((user, q) => this.find(user, q));
  }

  private async find(user: AuthUser, q: string): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    let campusId: string | undefined;
    try {
      campusId = this.scope.campus(user);
    } catch {
      return hits;
    }
    const campus = campusId ? { campusId } : {};
    if (can(user, 'operations.read', 'operations.manage')) {
      const [assets, items, requests] = await Promise.all([
        this.prisma.opsAsset.findMany({ where: { ...campus, status: { not: 'Retired' }, OR: [{ code: like(q) }, { name: like(q) }] }, take: 3, orderBy: { name: 'asc' } }),
        this.prisma.opsInventoryItem.findMany({ where: { ...campus, OR: [{ sku: like(q) }, { name: like(q) }] }, take: 3, orderBy: { name: 'asc' } }),
        this.prisma.opsMaintenanceRequest.findMany({ where: { ...campus, OR: [{ code: like(q) }, { description: like(q) }] }, take: 3, orderBy: { createdAt: 'desc' } }),
      ]);
      hits.push(
        ...assets.map((a) => ({ group: 'Assets', label: a.name, meta: `${a.code} · ${a.category}`, icon: 'box', route: `/assets?q=${encodeURIComponent(a.code)}` })),
        ...items.map((i) => ({ group: 'Inventory', label: i.name, meta: `${i.sku} · ${i.quantity} ${i.unit}`, icon: 'layers', route: `/inventory?q=${encodeURIComponent(i.sku)}` })),
        ...requests.map((r) => ({ group: 'Maintenance', label: r.description, meta: `${r.code} · ${r.status}`, icon: 'wrench', route: `/maintenance?q=${encodeURIComponent(r.code)}` })),
      );
    }
    if (can(user, 'documents.read', 'documents.manage')) {
      const [certs, docs] = await Promise.all([
        this.prisma.opsCertificate.findMany({ where: { ...campus, OR: [{ verificationCode: like(q) }, { studentName: like(q) }] }, take: 3, orderBy: { createdAt: 'desc' } }),
        this.prisma.opsDocument.findMany({ where: { studentId: null, OR: [{ name: like(q) }, { collection: like(q) }] }, take: 3, orderBy: { updatedAt: 'desc' } }),
      ]);
      hits.push(
        ...certs.map((c) => ({
          group: 'Certificates', label: `${c.certificateType} · ${c.studentName}`, meta: c.verificationCode ?? c.status, icon: 'award',
          route: `/certificates?q=${encodeURIComponent(c.verificationCode ?? c.admissionNo)}`,
        })),
        ...docs.map((d) => ({ group: 'Documents', label: d.name, meta: d.collection ?? 'Unfiled', icon: 'folder', route: `/documents?set=${encodeURIComponent(d.collection ?? 'Unfiled')}` })),
      );
    }
    return hits;
  }

  /** Every morning: requirements that just fell due or became overdue, assets due for service, documents that expired. */
  @Cron('0 7 * * *', { name: 'operations-daily', timeZone: TZ })
  @ForEachWorkspace('operations-daily')
  async daily() {
    try {
      await this.complianceReminders();
      await this.serviceReminders();
      await this.expiryReminders();
    } catch (err) {
      this.log.error(`Daily operations reminders failed: ${(err as Error).message}`);
    }
  }

  private async complianceReminders() {
    const t = today();
    const [overdue, soon] = await Promise.all([
      this.prisma.opsComplianceItem.findMany({ where: { status: { not: 'Completed' }, dueOn: addDays(t, -1) } }),
      this.prisma.opsComplianceItem.findMany({ where: { status: { not: 'Completed' }, dueOn: addDays(t, DUE_SOON_DAYS) } }),
    ]);
    for (const i of overdue) {
      const users = [...(await this.ctx.usersForEmployees([i.ownerId])), ...(await this.ctx.usersWithPermission('operations.manage', i.campusId))];
      await this.notifications.notifyUsers(users, {
        category: 'Critical', module: 'operations', title: `Overdue: ${i.item}`, body: `${i.authority} — the due date has passed.`,
        route: `/compliance?q=${encodeURIComponent(i.item)}`, campusId: i.campusId,
      });
    }
    for (const i of soon) {
      await this.notifications.notifyUsers(await this.ctx.usersForEmployees([i.ownerId]), {
        category: 'Attention', module: 'operations', title: `${i.item} is due in ${DUE_SOON_DAYS} days`, body: i.authority,
        route: `/compliance?q=${encodeURIComponent(i.item)}`, campusId: i.campusId,
      });
    }
  }

  private async serviceReminders() {
    const due = await this.prisma.opsAsset.groupBy({ by: ['campusId'], where: { status: { notIn: ['Retired', 'In maintenance'] }, nextServiceOn: today() }, _count: { _all: true } });
    for (const g of due) {
      const n = g._count._all;
      await this.notifications.notifyUsers(await this.ctx.usersWithPermission('operations.manage', g.campusId), {
        category: 'Attention', module: 'operations', title: `${n} asset${n === 1 ? ' is' : 's are'} due for service today`,
        body: 'Log the service or set a new date on the asset register.', route: '/assets?serviceDue=7', campusId: g.campusId,
      });
    }
  }

  private async expiryReminders() {
    const expired = await this.prisma.opsDocument.findMany({ where: { status: 'Verified', expiresOn: addDays(today(), -1) }, select: { name: true, campusId: true } });
    if (!expired.length) return;
    const users = await this.ctx.usersWithPermission('documents.manage');
    await this.notifications.notifyUsers(users, {
      category: 'Attention', module: 'documents',
      title: `${expired.length} document${expired.length === 1 ? ' has' : 's have'} expired`,
      body: expired.slice(0, 5).map((d) => d.name).join(', '), route: '/documents',
    });
  }
}
