import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma, SafetyIncident } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { fieldError, forbidden, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { dayStr, SafetyContext, SENSITIVE } from './safety.util';

export interface CreateIncidentInput {
  campusId: string;
  incidentType: string;
  summary: string;
  details?: string | null;
  severity: 'Critical' | 'Attention' | 'Information' | string;
  /** YYYY-MM-DD */
  occurredOn: string;
  isConfidential?: boolean;
  studentId?: string | null;
  /** Employee who owns the incident (defaults to the person logging it). */
  ownerId?: string | null;
  /** manual | pickup | emergency */
  source?: string;
}

export interface ComplianceItem {
  id: string;
  item: string;
  authority: string;
  owner: string;
  dueOn: string;
  status: string;
}

/** Supplies safeguarding training and compliance items (registered by the Operations module). */
export type ComplianceSource = (campusId: string | undefined) => Promise<ComplianceItem[]>;

export const INCIDENT_ENTITY = 'safety_incident';
/** Compliance items shown under Safeguarding › Training and compliance. */
const SAFEGUARDING_COMPLIANCE = /safeguard|child\s*protection|pocso|protection|background|police|verification|fire|evacuat|drill|first[\s-]*aid|cctv|safety|posh|medical|hygiene|transport/i;
export const SEVERITY_ORDER: Record<string, number> = { Critical: 0, Attention: 1, Information: 2 };
export const STATUS_ORDER: Record<string, number> = { Open: 0, 'Under Review': 1, Escalated: 2, Closed: 3 };

/** Incident register (INC-nnnn): safeguarding concerns and every other safety event. Reusable by other modules. */
@Injectable()
export class IncidentsService {
  private readonly log = new Logger(IncidentsService.name);
  private complianceSources: ComplianceSource[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: SafetyContext,
    private readonly counters: CountersService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /** Lets another module (Operations › Compliance) supply the "Training and compliance" list. */
  registerComplianceSource(fn: ComplianceSource) {
    this.complianceSources.push(fn);
  }

  async compliance(campusId: string | undefined): Promise<ComplianceItem[]> {
    const sources = [(c: string | undefined) => this.operationsCompliance(c), ...this.complianceSources];
    const lists = await Promise.all(sources.map((fn) => fn(campusId).catch(() => [] as ComplianceItem[])));
    const seen = new Set<string>();
    return lists.flat().filter((i) => !seen.has(i.id) && !!seen.add(i.id)).sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  }

  /**
   * Open safeguarding-related items from the Operations compliance calendar (child protection, background
   * checks, fire and evacuation safety, first aid…). Read structurally so this module does not depend on
   * the Operations schema at compile time; returns nothing if that table is absent.
   */
  private async operationsCompliance(campusId: string | undefined): Promise<ComplianceItem[]> {
    type Row = { id: string; item: string; authority: string; dueOn: Date; ownerId: string | null; status: string };
    const delegate = (this.prisma as unknown as { opsComplianceItem?: { findMany(args: unknown): Promise<Row[]> } }).opsComplianceItem;
    if (!delegate) return [];
    const rows = await delegate.findMany({ where: { ...(campusId ? { campusId } : {}), status: { not: 'Completed' } }, orderBy: { dueOn: 'asc' }, take: 500 });
    const relevant = rows.filter((r) => SAFEGUARDING_COMPLIANCE.test(`${r.item} ${r.authority}`));
    const owners = await this.ctx.employees(relevant.map((r) => r.ownerId));
    const clock = await this.ctx.clock();
    const today = new Date(`${clock.today()}T00:00:00.000Z`).getTime();
    return relevant.map((r) => {
      const days = Math.round((r.dueOn.getTime() - today) / (24 * 3600_000));
      return {
        id: r.id,
        item: r.item,
        authority: r.authority,
        owner: r.ownerId ? (owners.get(r.ownerId)?.fullName ?? '—') : '—',
        dueOn: dayStr(r.dueOn),
        status: days < 0 ? 'Overdue' : days <= 14 ? 'Due Soon' : r.status,
      };
    });
  }

  /** Logs an incident, alerts the DSL / Principal as the type and severity require, and assigns the 24-hour review. */
  async create(user: AuthUser | null, input: CreateIncidentInput, req?: Request): Promise<SafetyIncident> {
    const code = await this.counters.reference('INC', 'safety-incidents', 4);
    const ownerId = input.ownerId === undefined ? (user?.employeeId ?? null) : input.ownerId;
    const incident = await this.prisma.safetyIncident.create({
      data: {
        code,
        campusId: input.campusId,
        incidentType: input.incidentType,
        summary: input.summary,
        details: input.details ?? null,
        severity: input.severity,
        status: 'Open',
        occurredOn: new Date(`${input.occurredOn}T00:00:00.000Z`),
        isConfidential: !!input.isConfidential,
        studentId: input.studentId ?? null,
        ownerId,
        createdById: user?.id ?? null,
        source: input.source ?? 'manual',
      },
    });
    const route = '/safeguarding';
    const publicText = incident.isConfidential ? `A confidential ${incident.incidentType.toLowerCase()} record was logged.` : incident.summary;

    if (incident.incidentType === 'Safeguarding') {
      await this.notifications.notifyPermission(SENSITIVE, {
        category: incident.severity === 'Critical' ? 'Critical' : 'Attention',
        topic: 'safety',
        module: 'safety',
        title: `New safeguarding concern ${code}`,
        body: `${publicText} Review within 24 hours.`,
        route,
        campusId: incident.campusId,
        deliver: incident.severity === 'Critical',
      });
      const due = new Date(Date.now() + 24 * 3600_000);
      await this.notifications.createTaskForPermission(SENSITIVE, {
        title: `Review safeguarding concern ${code} within 24 hours`,
        module: 'safety',
        dueOn: due,
        priority: 'High',
        status: 'Under Review',
        route,
        entityType: INCIDENT_ENTITY,
        entityId: incident.id,
      }, incident.campusId);
    } else if (incident.severity === 'Critical') {
      const alert = {
        category: 'Critical' as const,
        topic: 'safety',
        module: 'safety',
        title: `Critical ${incident.incidentType.toLowerCase()} incident ${code}`,
        body: publicText,
        route,
        campusId: incident.campusId,
        deliver: true,
      };
      await this.notifications.notifyPermission(SENSITIVE, alert);
    }

    if (ownerId) {
      const owners = (await this.ctx.usersForEmployees([ownerId])).filter((id) => id !== user?.id);
      await this.notifications.notifyUsers(owners, {
        category: incident.severity === 'Critical' ? 'Critical' : 'Attention',
        topic: 'safety',
        module: 'safety',
        title: `You own incident ${code}`,
        body: publicText,
        route,
        campusId: incident.campusId,
      });
    }

    await this.audit.record({
      user,
      userName: user ? undefined : 'System',
      action: 'create',
      module: 'safety',
      entityType: INCIDENT_ENTITY,
      entityId: incident.id,
      campusId: incident.campusId,
      sensitive: incident.isConfidential || incident.incidentType === 'Safeguarding',
      description: `Logged ${incident.severity.toLowerCase()} ${incident.incidentType.toLowerCase()} incident ${code}${incident.isConfidential ? ' (confidential)' : `: ${incident.summary}`}`,
      req,
    });
    return incident;
  }

  /** Rows as the pages read them. */
  async rows(list: SafetyIncident[]) {
    const [students, owners, users, campuses] = await Promise.all([
      this.ctx.students(list.map((i) => i.studentId)),
      this.ctx.employees(list.map((i) => i.ownerId)),
      this.ctx.userNames(list.map((i) => i.createdById)),
      this.ctx.campusNames(list.map((i) => i.campusId)),
    ]);
    return list.map((i) => {
      const s = i.studentId ? students.get(i.studentId) : undefined;
      return {
        id: i.id,
        code: i.code,
        campusName: campuses.get(i.campusId) ?? '',
        incidentType: i.incidentType,
        summary: i.summary,
        details: i.details,
        severity: i.severity as 'Critical' | 'Attention' | 'Information',
        status: i.status as 'Open' | 'Under Review' | 'Escalated' | 'Closed',
        occurredOn: dayStr(i.occurredOn),
        isConfidential: i.isConfidential,
        studentId: i.studentId,
        studentName: s?.fullName ?? null,
        admissionNo: s?.admissionNo ?? null,
        ownerId: i.ownerId,
        ownerName: i.ownerId ? (owners.get(i.ownerId)?.fullName ?? null) : null,
        createdByName: i.createdById ? (users.get(i.createdById) ?? null) : i.source === 'manual' ? null : 'System',
        createdAt: i.createdAt.toISOString(),
        updatedAt: i.updatedAt.toISOString(),
      };
    });
  }

  /** Throws unless the user may open this record (confidential needs students.sensitive). */
  async get(user: AuthUser, id: string): Promise<SafetyIncident> {
    const incident = await this.prisma.safetyIncident.findUnique({ where: { id } });
    if (!incident) throw notFound('Incident');
    const campus = this.ctx.campus(user);
    if (campus && incident.campusId !== campus && user.scope !== 'school') throw forbidden('This incident is outside your access');
    if (incident.isConfidential && !user.permissions.has(SENSITIVE)) throw forbidden('This record is confidential. Only the Designated Safeguarding Lead, the Principal and the counsellor can open it.');
    return incident;
  }

  /** Status, severity, owner and notes. Escalation informs the Principal; closing completes the review tasks. */
  async update(user: AuthUser, id: string, dto: { status?: string; severity?: string; ownerId?: string | null; details?: string | null }, req?: Request) {
    const before = await this.get(user, id);
    const data: Prisma.SafetyIncidentUpdateInput = {};
    const notes: string[] = [];
    const now = new Date();

    if (dto.status && dto.status !== before.status) {
      data.status = dto.status;
      notes.push(`status ${before.status} → ${dto.status}`);
      if (dto.status !== 'Open' && !before.reviewedAt) Object.assign(data, { reviewedAt: now, reviewedById: user.id });
      if (dto.status === 'Escalated') Object.assign(data, { escalatedAt: now, principalInformedAt: now });
      if (dto.status === 'Closed') Object.assign(data, { closedAt: now, closedById: user.id });
      else if (before.status === 'Closed') Object.assign(data, { closedAt: null, closedById: null });
    }
    if (dto.severity && dto.severity !== before.severity) {
      data.severity = dto.severity;
      notes.push(`severity ${before.severity} → ${dto.severity}`);
    }
    if (dto.ownerId !== undefined && (dto.ownerId || null) !== before.ownerId) {
      if (dto.ownerId) {
        const owner = await this.prisma.employee.findUnique({ where: { id: dto.ownerId }, select: { id: true } });
        if (!owner) throw fieldError('ownerId', 'Choose a staff member');
      }
      data.ownerId = dto.ownerId || null;
      notes.push(dto.ownerId ? 'owner changed' : 'owner removed');
    }
    if (dto.details !== undefined && (dto.details ?? null) !== before.details) {
      data.details = dto.details?.trim() ? dto.details : null;
      notes.push('note added');
    }
    if (!notes.length) throw fieldError('note', 'Change the status, severity or owner, or add a note');

    const after = await this.prisma.safetyIncident.update({ where: { id }, data });
    const route = '/safeguarding';
    const publicText = after.isConfidential ? `Confidential ${after.incidentType.toLowerCase()} record` : after.summary;

    if (after.status !== 'Open' && before.status === 'Open') await this.notifications.completeTasksFor(INCIDENT_ENTITY, id);
    if (after.status === 'Closed' && before.status !== 'Closed') {
      await this.notifications.completeTasksFor(INCIDENT_ENTITY, id);
      await this.prisma.safetyPickupEvent.updateMany({ where: { incidentId: id, resolved: false }, data: { resolved: true, resolvedAt: now } });
    }
    if (after.status === 'Escalated' && before.status !== 'Escalated') {
      await this.notifications.notifyPermission(SENSITIVE, {
        category: 'Critical',
        topic: 'safety',
        module: 'safety',
        title: `${after.code} escalated — external referral`,
        body: `${publicText}. The Principal is informed of every referral.`,
        route,
        campusId: after.campusId,
        deliver: true,
      });
    }
    if (after.severity === 'Critical' && before.severity !== 'Critical' && after.status !== 'Closed') {
      await this.notifications.notifyPermission(SENSITIVE, {
        category: 'Critical',
        topic: 'safety',
        module: 'safety',
        title: `${after.code} raised to Critical`,
        body: publicText,
        route,
        campusId: after.campusId,
        deliver: true,
      });
    }
    if (after.ownerId && after.ownerId !== before.ownerId) {
      const owners = (await this.ctx.usersForEmployees([after.ownerId])).filter((u) => u !== user.id);
      await this.notifications.notifyUsers(owners, {
        category: 'Attention',
        topic: 'safety',
        module: 'safety',
        title: `You now own incident ${after.code}`,
        body: publicText,
        route,
        campusId: after.campusId,
      });
    }

    await this.audit.record({
      user,
      action: after.status === 'Closed' && before.status !== 'Closed' ? 'approve' : 'update',
      module: 'safety',
      entityType: INCIDENT_ENTITY,
      entityId: id,
      campusId: after.campusId,
      sensitive: after.isConfidential || after.incidentType === 'Safeguarding',
      description: `Updated ${after.code}: ${notes.join(', ')}`,
      req,
    });
    const message = after.status !== before.status
      ? after.status === 'Closed' ? `${after.code} closed` : after.status === 'Escalated' ? `${after.code} escalated — Principal informed` : `${after.code} is now ${after.status}`
      : `${after.code} updated`;
    return { incident: after, message };
  }

  /** Open incidents (any type) for dashboards. */
  async openCount(campusId?: string): Promise<{ open: number; critical: number; safeguarding: number }> {
    const where: Prisma.SafetyIncidentWhereInput = { ...(campusId ? { campusId } : {}), status: { not: 'Closed' } };
    const [open, critical, safeguarding] = await Promise.all([
      this.prisma.safetyIncident.count({ where }),
      this.prisma.safetyIncident.count({ where: { ...where, severity: 'Critical' } }),
      this.prisma.safetyIncident.count({ where: { ...where, incidentType: 'Safeguarding' } }),
    ]);
    return { open, critical, safeguarding };
  }

  /** Concerns still waiting for the DSL review after 24 hours get one reminder. */
  @Cron(CronExpression.EVERY_HOUR)
  async remindOverdueReviews() {
    try {
      const overdue = await this.prisma.safetyIncident.findMany({
        where: { incidentType: 'Safeguarding', status: 'Open', reviewReminderAt: null, createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } },
        take: 200,
      });
      for (const i of overdue) {
        await this.notifications.notifyPermission(SENSITIVE, {
          category: 'Critical',
          topic: 'safety',
          module: 'safety',
          title: `Safeguarding concern ${i.code} is overdue for review`,
          body: 'Concerns must be reviewed by the Designated Safeguarding Lead within 24 hours.',
          route: '/safeguarding',
          campusId: i.campusId,
        });
        await this.prisma.safetyIncident.update({ where: { id: i.id }, data: { reviewReminderAt: new Date() } });
      }
    } catch (err) {
      this.log.warn(`Review reminders failed: ${(err as Error).message}`);
    }
  }
}
