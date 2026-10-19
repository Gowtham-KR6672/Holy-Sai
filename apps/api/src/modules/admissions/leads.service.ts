import { Injectable } from '@nestjs/common';
import type { AdmissionFollowUp, AdmissionLead, Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { badRequest, fieldError, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import {
  APP_LIVE, CLOSED, DOCUMENTS, STAGES, VISIT, asDate, atTime, dateOnly, dateToInstant, dayKey, gradeLevel, iso, monthStart, phoneKey, stageIndex,
  stageOrder, todayKey, whenLabel,
} from './admissions.util';

export type Actor = Pick<AuthUser, 'id' | 'fullName'>;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Path ids must be uuids before they reach Postgres. */
export const assertId = (id: string, what = 'Record') => {
  if (!UUID.test(id)) throw notFound(what);
  return id;
};

export const LEAD_INCLUDE = {
  applications: { orderBy: { createdAt: 'desc' as const }, take: 1, select: { id: true, applicationNo: true, status: true } },
} satisfies Prisma.AdmissionLeadInclude;
export type LeadWithApp = Prisma.AdmissionLeadGetPayload<{ include: typeof LEAD_INCLUDE }>;
type AppWithDocs = Prisma.AdmissionApplicationGetPayload<{ include: { documents: true } }>;

const CONTACT_TYPES = ['Call', 'WhatsApp', 'Email', 'SMS', 'Meeting', VISIT];
const MESSAGE_TYPES = ['Call', 'WhatsApp', 'Email', 'SMS'];
const FU_ENTITY = 'admission_follow_up';

export interface NewLead {
  campusId: string;
  parentName: string;
  phone: string;
  email?: string | null;
  studentName: string;
  studentDob?: string | null;
  grade: string;
  curriculum?: string | null;
  source: string;
  campaign?: string | null;
  score: number;
  counsellorId?: string | null;
  transportRequired?: boolean;
  notes?: string | null;
}

/** Lead lifecycle shared by every admissions screen: stages, follow-ups, applications, referrals and cost. */
@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly counters: CountersService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly scope: ScopeService,
  ) {}

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  /** Start of the current academic year (school time); 1 April when no year is set up. */
  async yearStart(): Promise<Date> {
    const y = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    if (y && y.startsOn <= new Date()) return dateToInstant(y.startsOn);
    const k = todayKey();
    const yr = Number(k.slice(0, 4));
    return dateToInstant(asDate(`${Number(k.slice(5, 7)) >= 4 ? yr : yr - 1}-04-01`));
  }

  async campusNames(ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map<string, string>();
    const rows = await this.prisma.campus.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
    return new Map(rows.map((c) => [c.id, c.name]));
  }

  async employeeNames(ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map<string, string>();
    const rows = await this.prisma.employee.findMany({ where: { id: { in: list } }, select: { id: true, fullName: true } });
    return new Map(rows.map((e) => [e.id, e.fullName]));
  }

  /** The user account linked to an employee, if any. */
  async userOfEmployee(employeeId: string | null | undefined) {
    if (!employeeId) return null;
    const u = await this.prisma.user.findFirst({ where: { employeeId, status: 'active' }, select: { id: true } });
    return u?.id ?? null;
  }

  /** A staff member who can own leads, follow-ups or visits. */
  async employee(id: string, field: string) {
    if (!UUID.test(id)) throw fieldError(field, 'Choose a counsellor from the list');
    const e = await this.prisma.employee.findFirst({ where: { id, archivedAt: null, employmentStatus: { not: 'exited' } } });
    if (!e) throw fieldError(field, 'Choose a counsellor from the list');
    return e;
  }

  async findLead(ref: string, user?: AuthUser) {
    const key = decodeURIComponent(ref).trim();
    const lead = UUID.test(key)
      ? await this.prisma.admissionLead.findUnique({ where: { id: key } })
      : await this.prisma.admissionLead.findUnique({ where: { code: key.toUpperCase() } });
    if (!lead) throw notFound('Lead');
    if (user) this.scope.campus(user, lead.campusId);
    return lead;
  }

  /** Admissions counsellors: admissions/counselling staff and front-office staff, with their open-lead load. */
  async counsellors(campusId?: string) {
    const [officeUsers, assigned] = await Promise.all([
      this.prisma.user.findMany({ where: { employeeId: { not: null }, status: 'active', role: { key: 'office' } }, select: { employeeId: true } }),
      this.prisma.admissionLead.findMany({ where: { counsellorId: { not: null }, stage: { notIn: CLOSED } }, distinct: ['counsellorId'], select: { counsellorId: true } }),
    ]);
    const base: Prisma.EmployeeWhereInput = { archivedAt: null, employmentStatus: { not: 'exited' }, ...(campusId ? { campusId } : {}) };
    let employees = await this.prisma.employee.findMany({
      where: {
        ...base,
        OR: [
          { department: { contains: 'admission', mode: 'insensitive' } },
          { designation: { contains: 'admission', mode: 'insensitive' } },
          { designation: { contains: 'counsel', mode: 'insensitive' } },
          { category: 'Reception & Admin' },
          { id: { in: officeUsers.map((u) => u.employeeId!) } },
          { id: { in: assigned.map((a) => a.counsellorId!) } },
        ],
      },
      orderBy: { fullName: 'asc' },
    });
    if (!employees.length) {
      // No dedicated admissions staff yet: anyone whose account can manage admissions.
      const managers = await this.prisma.user.findMany({
        where: { employeeId: { not: null }, status: 'active', role: { permissions: { some: { permissionKey: 'admissions.manage' } } } },
        select: { employeeId: true },
      });
      employees = await this.prisma.employee.findMany({ where: { ...base, id: { in: managers.map((m) => m.employeeId!) } }, orderBy: { fullName: 'asc' } });
    }
    const ids = employees.map((e) => e.id);
    const [accounts, open, campuses] = await Promise.all([
      this.prisma.user.findMany({ where: { employeeId: { in: ids }, status: 'active' }, select: { employeeId: true } }),
      this.prisma.admissionLead.groupBy({ by: ['counsellorId'], where: { counsellorId: { in: ids }, stage: { notIn: CLOSED } }, _count: { _all: true } }),
      this.campusNames(employees.map((e) => e.campusId)),
    ]);
    const withAccount = new Set(accounts.map((a) => a.employeeId));
    const openBy = new Map(open.map((o) => [o.counsellorId, o._count._all]));
    return employees.map((e) => ({
      id: e.id,
      fullName: e.fullName,
      designation: e.designation,
      campusId: e.campusId,
      campusName: campuses.get(e.campusId) ?? '',
      hasAccount: withAccount.has(e.id),
      openLeads: openBy.get(e.id) ?? 0,
    }));
  }

  // -------------------------------------------------------------------------
  // Shapes
  // -------------------------------------------------------------------------

  async leadRows(leads: LeadWithApp[]) {
    const [campuses, staff] = await Promise.all([this.campusNames(leads.map((l) => l.campusId)), this.employeeNames(leads.map((l) => l.counsellorId))]);
    const now = Date.now();
    return leads.map((l) => this.leadRow(l, campuses.get(l.campusId) ?? '', l.counsellorId ? staff.get(l.counsellorId) ?? l.counsellorName : null, now));
  }

  leadRow(l: LeadWithApp, campusName: string, counsellor: string | null, now = Date.now()) {
    const open = !CLOSED.includes(l.stage);
    const app = l.applications[0];
    return {
      id: l.id,
      code: l.code,
      parentName: l.parentName,
      phone: l.phone,
      email: l.email,
      studentName: l.studentName,
      studentDob: dateOnly(l.studentDob),
      grade: l.grade,
      curriculum: l.curriculum,
      source: l.source,
      campaign: l.campaign,
      stage: l.stage,
      score: l.score,
      counsellorId: l.counsellorId,
      counsellor: counsellor ?? null,
      transportRequired: l.transportRequired,
      nextAction: open ? l.nextAction : null,
      nextActionAt: open ? iso(l.nextActionAt) : null,
      overdue: open && !!l.nextActionAt && l.nextActionAt.getTime() < now,
      lostReason: l.lostReason,
      acquisitionCost: Number(l.acquisitionCost),
      campusId: l.campusId,
      campusName,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
      applicationId: app?.id ?? null,
      applicationNo: app?.applicationNo ?? null,
      applicationStatus: app?.status ?? null,
      studentId: l.studentId,
    };
  }

  applicationView(a: AppWithDocs) {
    const docs = [...a.documents].sort((x, y) => x.sortOrder - y.sortOrder);
    return {
      id: a.id,
      applicationNo: a.applicationNo,
      status: a.status,
      studentName: a.studentName,
      dateOfBirth: dateOnly(a.dateOfBirth),
      gender: (a.gender as 'M' | 'F' | 'O' | null) ?? null,
      grade: a.grade,
      previousSchool: a.previousSchool,
      documentsComplete: docs.length > 0 && docs.every((d) => d.status === 'Verified'),
      assessmentAt: iso(a.assessmentAt),
      assessmentScore: a.assessmentScore,
      offerExpiresOn: dateOnly(a.offerExpiresOn),
      feePaid: a.feePaid,
      studentId: a.studentId,
      admissionNo: a.admissionNo,
      decidedAt: iso(a.decidedAt),
      decidedBy: a.decidedByName,
      createdAt: a.createdAt.toISOString(),
      campusId: a.campusId,
      documents: docs.map((d) => ({ id: d.id, name: d.name, status: d.status, verifiedAt: iso(d.verifiedAt) })),
    };
  }

  followUpLabel(f: Pick<AdmissionFollowUp, 'type' | 'notes'>) {
    if (f.type === VISIT) return 'Campus visit';
    const notes = f.notes?.trim();
    return notes ? `${f.type} · ${notes.length > 80 ? `${notes.slice(0, 79)}…` : notes}` : f.type;
  }

  // -------------------------------------------------------------------------
  // Creating leads
  // -------------------------------------------------------------------------

  async createLead(input: NewLead, actor: Actor, fieldPrefix = '') {
    const f = (k: string) => `${fieldPrefix}${k}`;
    const campus = UUID.test(input.campusId) ? await this.prisma.campus.findUnique({ where: { id: input.campusId } }) : null;
    if (!campus) throw fieldError(f('campusId'), 'Choose a campus');
    if (input.studentDob && input.studentDob.slice(0, 10) >= todayKey()) throw fieldError(f('studentDob'), 'Date of birth must be in the past');
    const counsellor = input.counsellorId ? await this.employee(input.counsellorId, f('counsellorId')) : null;
    const code = await this.counters.reference('LD', 'admission-leads', 0, 1001);
    const lead = await this.prisma.admissionLead.create({
      data: {
        code,
        campusId: campus.id,
        parentName: input.parentName.trim(),
        phone: input.phone.trim(),
        phoneKey: phoneKey(input.phone),
        email: input.email?.trim().toLowerCase() || null,
        studentName: input.studentName.trim(),
        studentDob: input.studentDob ? asDate(input.studentDob.slice(0, 10)) : null,
        grade: input.grade,
        gradeLevel: gradeLevel(input.grade),
        curriculum: input.curriculum?.trim() || null,
        source: input.source,
        campaign: input.campaign?.trim() || null,
        score: input.score,
        counsellorId: counsellor?.id ?? null,
        counsellorName: counsellor?.fullName ?? null,
        assignedAt: counsellor ? new Date() : null,
        transportRequired: !!input.transportRequired,
        notes: input.notes?.trim() || null,
        createdById: actor.id,
      },
    });
    await this.prisma.admissionStageHistory.create({
      data: { leadId: lead.id, toStage: 'New Lead', note: `Enquiry received via ${input.source}${input.campaign ? ` (${input.campaign})` : ''}`, changedById: actor.id, changedByName: actor.fullName },
    });
    // Every new enquiry gets a first-contact follow-up for tomorrow morning.
    const fu = await this.prisma.admissionFollowUp.create({
      data: {
        leadId: lead.id, type: 'Call', scheduledAt: atTime(1, 10), notes: 'First contact', assignedTo: counsellor?.id ?? null,
        assignedName: counsellor?.fullName ?? null, createdById: actor.id,
      },
    });
    await this.taskFor(fu, lead);
    await this.refreshNext(lead.id);
    await this.reallocate(lead.source, lead.createdAt);
    if (counsellor) await this.notifyAssigned(counsellor.id, [lead]);
    return lead;
  }

  /** Tells a counsellor (if they have an account) about leads assigned to them. */
  async notifyAssigned(counsellorId: string, leads: Pick<AdmissionLead, 'code' | 'studentName' | 'grade' | 'source' | 'campusId'>[]) {
    const userId = await this.userOfEmployee(counsellorId);
    if (!userId || !leads.length) return false;
    const one = leads.length === 1 ? leads[0] : null;
    await this.notifications.notifyUsers([userId], {
      category: 'Attention',
      topic: 'system',
      module: 'admissions',
      icon: 'userCheck',
      title: one ? `New lead assigned: ${one.studentName}` : `${leads.length} leads assigned to you`,
      body: one ? `${one.code} · ${one.grade} · ${one.source}. Make first contact within a day.` : leads.map((l) => l.code).slice(0, 10).join(', '),
      route: one ? `/leads?lead=${one.code}` : '/leads?counsellorId=' + counsellorId,
      campusId: one?.campusId ?? null,
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Stages
  // -------------------------------------------------------------------------

  /** Moves a lead to a stage, recording the move and its note in the stage history. */
  async moveStage(lead: AdmissionLead, to: string, note: string | null, actor: Actor | null, opts: { lostReason?: string | null } = {}) {
    if (lead.stage === to) return lead;
    const idx = stageIndex(to);
    const now = new Date();
    const data: Prisma.AdmissionLeadUpdateInput = { stage: to, stageOrder: stageOrder(to), stageChangedAt: now };
    if (idx >= 0) data.maxStageIndex = Math.max(lead.maxStageIndex, idx);
    if (to === 'Lost') Object.assign(data, { lostReason: opts.lostReason ?? lead.lostReason ?? null, lostAt: now });
    else Object.assign(data, { lostReason: null, lostAt: null });
    if (to === 'Enrolled') data.enrolledAt = now;
    if (idx >= 1 && !lead.firstContactAt) data.firstContactAt = now;
    const updated = await this.prisma.admissionLead.update({ where: { id: lead.id }, data });
    await this.prisma.admissionStageHistory.create({
      data: {
        leadId: lead.id, fromStage: lead.stage, toStage: to,
        note: to === 'Lost' && opts.lostReason ? `${opts.lostReason}${note ? ` — ${note}` : ''}` : note,
        changedById: actor?.id ?? null, changedByName: actor?.fullName ?? 'System',
      },
    });
    if (CLOSED.includes(to)) await this.closeOpenFollowUps(lead.id, to === 'Enrolled' ? 'Lead enrolled' : 'Lead closed');
    await this.syncReferrals(lead.id, to, actor);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Follow-ups
  // -------------------------------------------------------------------------

  async refreshNext(leadId: string) {
    const next = await this.prisma.admissionFollowUp.findFirst({ where: { leadId, status: 'Scheduled' }, orderBy: { scheduledAt: 'asc' } });
    await this.prisma.admissionLead.update({
      where: { id: leadId },
      data: { nextAction: next ? this.followUpLabel(next) : null, nextActionAt: next?.scheduledAt ?? null },
    });
  }

  /** Puts a follow-up in its assignee's task list (when they have an account). */
  async taskFor(fu: AdmissionFollowUp, lead: Pick<AdmissionLead, 'code' | 'studentName' | 'parentName'>) {
    const userId = await this.userOfEmployee(fu.assignedTo);
    if (!userId) return;
    await this.notifications.createTask({
      title: `${fu.type === VISIT ? 'Host campus visit' : fu.type}: ${lead.studentName} (${lead.code})`,
      module: 'admissions',
      assigneeId: userId,
      dueOn: dayKey(fu.scheduledAt),
      priority: fu.type === VISIT ? 'High' : 'Medium',
      route: `/leads?lead=${lead.code}`,
      entityType: FU_ENTITY,
      entityId: fu.id,
    });
  }

  async scheduleFollowUp(lead: AdmissionLead, input: { type: string; scheduledAt: Date; notes: string | null; assignedTo: string | null }, actor: Actor) {
    if (CLOSED.includes(lead.stage)) throw badRequest(`This lead is ${lead.stage.toLowerCase()} — reopen it before scheduling follow-ups`);
    if (input.scheduledAt.getTime() < Date.now() - 5 * 60_000) throw fieldError('scheduledAt', 'Choose a future date and time');
    const visit = input.type === VISIT;
    const owner = input.assignedTo ? await this.employee(input.assignedTo, visit ? 'hostId' : 'assignedTo') : null;
    const fu = await this.prisma.admissionFollowUp.create({
      data: {
        leadId: lead.id, type: input.type, scheduledAt: input.scheduledAt, notes: input.notes, assignedTo: owner?.id ?? null,
        assignedName: owner?.fullName ?? null, createdById: actor.id,
      },
    });
    await this.taskFor(fu, lead);
    if (visit && owner && owner.id !== lead.counsellorId) {
      const userId = await this.userOfEmployee(owner.id);
      if (userId && userId !== actor.id) {
        await this.notifications.notifyUsers([userId], {
          category: 'Information', topic: 'events', module: 'admissions', icon: 'mapPin',
          title: `Campus visit to host: ${lead.parentName}`, body: `${lead.studentName} (${lead.grade}) · ${whenLabel(input.scheduledAt)}`,
          route: `/visits?lead=${lead.code}`, campusId: lead.campusId,
        });
      }
    }
    if (visit && stageIndex(lead.stage) < stageIndex('Visit Scheduled')) {
      await this.moveStage(lead, 'Visit Scheduled', `Campus visit booked for ${whenLabel(input.scheduledAt)}`, actor);
    }
    await this.refreshNext(lead.id);
    return fu;
  }

  /** Changes who owns an open follow-up (or hosts a visit). */
  async reassignFollowUp(fu: AdmissionFollowUp, assignedTo: string | null, actor: Actor) {
    const owner = assignedTo ? await this.employee(assignedTo, fu.type === VISIT ? 'hostId' : 'assignedTo') : null;
    if ((owner?.id ?? null) === fu.assignedTo) return fu;
    const updated = await this.prisma.admissionFollowUp.update({ where: { id: fu.id }, data: { assignedTo: owner?.id ?? null, assignedName: owner?.fullName ?? null } });
    await this.prisma.task.deleteMany({ where: { entityType: FU_ENTITY, entityId: fu.id, status: { not: 'Completed' } } });
    if (updated.status === 'Scheduled') {
      const lead = await this.prisma.admissionLead.findUniqueOrThrow({ where: { id: fu.leadId } });
      await this.taskFor(updated, lead);
    }
    void actor;
    return updated;
  }

  /** Completes, records a no-show for, or cancels a follow-up; visits and first contact move the lead on. */
  async closeFollowUp(fu: AdmissionFollowUp, status: 'Completed' | 'Missed' | 'Cancelled', outcome: string | null, notes: string | null, actor: Actor) {
    if (fu.status !== 'Scheduled') throw badRequest(`This ${fu.type === VISIT ? 'visit' : 'follow-up'} is already ${fu.status.toLowerCase()}`);
    if (status === 'Completed' && !outcome) throw fieldError('outcome', 'Record what happened');
    const now = new Date();
    const updated = await this.prisma.admissionFollowUp.update({
      where: { id: fu.id },
      data: { status, completedAt: now, outcome, notes: notes ? (fu.notes ? `${fu.notes} — ${notes}` : notes) : fu.notes },
    });
    await this.notifications.completeTasksFor(FU_ENTITY, fu.id);
    let lead = await this.prisma.admissionLead.findUniqueOrThrow({ where: { id: fu.leadId } });
    if (status === 'Completed') {
      if (CONTACT_TYPES.includes(fu.type) && !lead.firstContactAt) {
        lead = await this.prisma.admissionLead.update({ where: { id: lead.id }, data: { firstContactAt: now } });
      }
      if (MESSAGE_TYPES.includes(fu.type)) {
        await this.prisma.crmCommunication.create({
          data: {
            leadId: lead.id, counterpart: lead.parentName, channel: fu.type, direction: 'Outbound', subject: outcome ?? fu.type,
            body: notes, status: 'Completed', sentById: actor.id, sentByName: actor.fullName,
          },
        });
      }
      if (!CLOSED.includes(lead.stage)) {
        if (fu.type === VISIT && stageIndex(lead.stage) < stageIndex('Visit Completed')) {
          lead = await this.moveStage(lead, 'Visit Completed', `Visit completed: ${outcome}`, actor);
        } else if (lead.stage === 'New Lead' && CONTACT_TYPES.includes(fu.type)) {
          lead = await this.moveStage(lead, 'Contacted', `${fu.type} completed: ${outcome}`, actor);
        }
      }
    }
    await this.refreshNext(lead.id);
    return updated;
  }

  private async closeOpenFollowUps(leadId: string, outcome: string) {
    const open = await this.prisma.admissionFollowUp.findMany({ where: { leadId, status: 'Scheduled' }, select: { id: true } });
    if (!open.length) return;
    await this.prisma.admissionFollowUp.updateMany({ where: { id: { in: open.map((o) => o.id) } }, data: { status: 'Cancelled', completedAt: new Date(), outcome } });
    await this.prisma.task.updateMany({
      where: { entityType: FU_ENTITY, entityId: { in: open.map((o) => o.id) }, status: { not: 'Completed' } },
      data: { status: 'Completed', completedAt: new Date() },
    });
    await this.refreshNext(leadId);
  }

  // -------------------------------------------------------------------------
  // Applications
  // -------------------------------------------------------------------------

  /** Opens an application with the standard document checklist (or returns the live one). */
  async openApplication(lead: AdmissionLead, actor: Actor) {
    const live = await this.prisma.admissionApplication.findFirst({ where: { leadId: lead.id, status: { in: APP_LIVE } }, orderBy: { createdAt: 'desc' } });
    if (live) return { app: live, created: false };
    const year = todayKey().slice(0, 4);
    const applicationNo = await this.counters.reference(`APP-${year}`, `admission-applications-${year}`, 4);
    const app = await this.prisma.admissionApplication.create({
      data: {
        applicationNo, leadId: lead.id, campusId: lead.campusId, status: 'Submitted', studentName: lead.studentName, dateOfBirth: lead.studentDob,
        grade: lead.grade, createdById: actor.id, documents: { create: DOCUMENTS.map((name, i) => ({ name, sortOrder: i })) },
      },
    });
    return { app, created: true };
  }

  // -------------------------------------------------------------------------
  // Referrals
  // -------------------------------------------------------------------------

  /** Keeps referral status and recognition in step with the referred lead. */
  async syncReferrals(leadId: string, stage: string, actor: Actor | null) {
    const refs = await this.prisma.admissionReferral.findMany({ where: { leadId } });
    if (!refs.length) return;
    const status = stage === 'Enrolled' ? 'Enrolled' : stage === 'Lost' ? 'Lost' : stage === 'New Lead' ? 'Submitted' : 'Contacted';
    const reward = stage === 'Enrolled' ? Number(await this.settings.get<number>('admissions.referral_reward', 0)) || 0 : 0;
    for (const r of refs) {
      const data: Prisma.AdmissionReferralUpdateInput = { status };
      if (status === 'Enrolled' && r.rewardStatus === 'Not eligible') Object.assign(data, { rewardStatus: 'Pending', rewardAmount: reward });
      if (status === 'Lost' && r.rewardStatus === 'Pending') Object.assign(data, { rewardStatus: 'Not eligible' });
      await this.prisma.admissionReferral.update({ where: { id: r.id }, data });
      if (status === 'Enrolled' && r.rewardStatus === 'Not eligible') {
        await this.notifications.notifyPermission('admissions.manage', {
          category: 'Attention', topic: 'system', module: 'admissions', icon: 'award', campusId: r.campusId,
          title: `Referral recognition due: ${r.referrerName}`,
          body: `${r.referredName} has enrolled. Acknowledge the recognition for the referring family.`,
          route: '/referrals?rewardStatus=Pending',
        });
      }
    }
    void actor;
  }

  // -------------------------------------------------------------------------
  // Marketing cost
  // -------------------------------------------------------------------------

  /** Spreads the month's marketing spend for a source over that month's leads from the source. */
  async reallocate(source: string, when: Date) {
    const start = monthStart(when);
    const end = monthStart(when, 1);
    const month = asDate(dayKey(when).slice(0, 8) + '01');
    const [spends, leads] = await Promise.all([
      this.prisma.admissionMarketingSpend.findMany({ where: { source, month } }),
      this.prisma.admissionLead.findMany({ where: { source, createdAt: { gte: start, lt: end } }, select: { id: true, campusId: true } }),
    ]);
    if (!leads.length) return;
    const groupWide = spends.filter((s) => !s.campusId).reduce((n, s) => n + Number(s.amount), 0);
    const byCampus = new Map<string, number>();
    for (const s of spends) if (s.campusId) byCampus.set(s.campusId, (byCampus.get(s.campusId) ?? 0) + Number(s.amount));
    const perCampus = new Map<string, string[]>();
    for (const l of leads) perCampus.set(l.campusId, [...(perCampus.get(l.campusId) ?? []), l.id]);
    for (const [campusId, ids] of perCampus) {
      const cost = (byCampus.get(campusId) ?? 0) / ids.length + groupWide / leads.length;
      await this.prisma.admissionLead.updateMany({ where: { id: { in: ids } }, data: { acquisitionCost: Math.round(cost * 100) / 100 } });
    }
  }

  /** Marketing spend over a period (by source), optionally for one campus. */
  async spendBySource(from: Date, to: Date, campusId?: string) {
    const rows = await this.prisma.admissionMarketingSpend.findMany({
      where: { month: { gte: asDate(dayKey(from).slice(0, 8) + '01'), lte: asDate(dayKey(to)) }, ...(campusId ? { campusId } : {}) },
    });
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.source, (out.get(r.source) ?? 0) + Number(r.amount));
    return out;
  }

  stages() {
    return [...STAGES];
  }
}
