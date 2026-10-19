import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { AdmissionFollowUp, CrmCommunication, Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, notFound } from '../../common/errors';
import { like, pageOf, sortBy } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import {
  AssignDto, CampusQuery, CreateLeadDto, FollowUpDto, FollowUpPatchDto, LeadCommunicationDto, LeadQuery, StageDto, VisitDto, VisitQuery,
} from './admissions.dto';
import { APP_LIVE, CLOSED, STAGES, VISIT, change, dayStart, iso, median, monthStart, pct, stageIndex, weekStart } from './admissions.util';
import { LEAD_INCLUDE, LeadsService, UUID, assertId } from './leads.service';

const READ = ['admissions.read', 'admissions.manage'];
const DAY = 86_400_000;

type LeadOrder = Prisma.AdmissionLeadOrderByWithRelationInput[];
const LEAD_SORT: Record<string, (d: 'asc' | 'desc') => LeadOrder> = {
  created: (d) => [{ createdAt: d }],
  student: (d) => [{ studentName: d }],
  grade: (d) => [{ gradeLevel: d }, { grade: d }],
  curriculum: (d) => [{ curriculum: { sort: d, nulls: 'last' } }],
  source: (d) => [{ source: d }],
  stage: (d) => [{ stageOrder: d }],
  next: (d) => [{ nextActionAt: { sort: d, nulls: d === 'asc' ? 'last' : 'first' } }],
  counsellor: (d) => [{ counsellorName: { sort: d, nulls: 'last' } }],
  score: (d) => [{ score: d }],
};

type VisitOrder = Prisma.AdmissionFollowUpOrderByWithRelationInput[];
const VISIT_SORT: Record<string, (d: 'asc' | 'desc') => VisitOrder> = {
  when: (d) => [{ scheduledAt: d }],
  family: (d) => [{ lead: { parentName: d } }],
  grade: (d) => [{ lead: { gradeLevel: d } }],
  host: (d) => [{ assignedName: { sort: d, nulls: 'first' } }],
  status: (d) => [{ status: d }],
};

export const commView = (c: CrmCommunication) => ({
  id: c.id,
  channel: c.channel,
  direction: c.direction,
  counterpart: c.counterpart,
  subject: c.subject,
  body: c.body,
  status: c.status,
  occurredAt: c.occurredAt.toISOString(),
  sentBy: c.sentByName,
  automated: c.automated,
});

/** Leads (enquiries), their stage moves, follow-ups, communication log and campus visits. */
@Controller()
export class EnquiriesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Lists
  // -------------------------------------------------------------------------

  @Get('enquiries')
  @RequirePermissions(...READ)
  async list(@Query() q: LeadQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const where = this.leadWhere(q, user);
    const orderBy = q.sort ? [...sortBy(q.sort, q.dir, LEAD_SORT, 'created'), { createdAt: 'desc' as const }] : [{ createdAt: 'desc' as const }];
    const [rows, total] = await Promise.all([
      this.prisma.admissionLead.findMany({ where, include: LEAD_INCLUDE, orderBy, skip: p.skip, take: p.take }),
      this.prisma.admissionLead.count({ where }),
    ]);
    return paged(await this.leads.leadRows(rows), total, p);
  }

  @Get('enquiries/summary')
  @RequirePermissions(...READ)
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const base: Prisma.AdmissionLeadWhereInput = campusId ? { campusId } : {};
    const now = new Date();
    const start = monthStart(now);
    const prevStart = monthStart(now, -1);
    const prevEnd = new Date(Math.min(prevStart.getTime() + (now.getTime() - start.getTime()), start.getTime()));
    const month: Prisma.AdmissionLeadWhereInput = { ...base, createdAt: { gte: start } };
    const [thisMonth, prev, aiLeads, needingHuman, unassigned, channels, monthLeads] = await Promise.all([
      this.prisma.admissionLead.count({ where: month }),
      this.prisma.admissionLead.count({ where: { ...base, createdAt: { gte: prevStart, lt: prevEnd } } }),
      this.prisma.admissionLead.findMany({
        where: { ...month, communications: { some: { automated: true, direction: 'Outbound' } } },
        select: { createdAt: true, communications: { where: { automated: true, direction: 'Outbound' }, orderBy: { occurredAt: 'asc' }, take: 1, select: { occurredAt: true } } },
      }),
      this.prisma.admissionLead.count({ where: { ...month, stage: 'New Lead', firstContactAt: null } }),
      this.prisma.admissionLead.count({ where: { ...base, counsellorId: null, stage: { notIn: CLOSED } } }),
      this.prisma.admissionLead.groupBy({ by: ['source'], where: month, _count: { _all: true } }),
      this.prisma.admissionLead.findMany({ where: month, select: { phoneKey: true } }),
    ]);
    const keys = [...new Set(monthLeads.map((l) => l.phoneKey).filter((k) => k.length >= 8))];
    const dupGroups = keys.length
      ? await this.prisma.admissionLead.groupBy({ by: ['phoneKey'], where: { ...base, phoneKey: { in: keys } }, _count: { _all: true } })
      : [];
    const dupKeys = new Set(dupGroups.filter((g) => g._count._all > 1).map((g) => g.phoneKey));
    const replies = aiLeads.filter((l) => l.communications[0]).map((l) => Math.max(0, Math.round((l.communications[0].occurredAt.getTime() - l.createdAt.getTime()) / 1000)));
    const med = median(replies);
    return {
      thisMonth,
      monthDelta: change(thisMonth, prev),
      aiAnswered: aiLeads.length,
      aiAnsweredPct: pct(aiLeads.length, thisMonth),
      medianReplySeconds: med == null ? null : Math.round(med),
      needingHuman,
      unassigned,
      duplicates: monthLeads.filter((l) => dupKeys.has(l.phoneKey)).length,
      channels: channels.map((c) => ({ label: c.source, value: c._count._all })).sort((a, b) => b.value - a.value),
    };
  }

  @Get('enquiries/pipeline')
  @RequirePermissions(...READ)
  async pipeline(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const since = new Date(Date.now() - 60 * DAY);
    const cols = await Promise.all(
      STAGES.map(async (stage) => {
        const where: Prisma.AdmissionLeadWhereInput = { ...(campusId ? { campusId } : {}), stage, ...(stage === 'Enrolled' ? { enrolledAt: { gte: since } } : {}) };
        const [count, rows] = await Promise.all([
          this.prisma.admissionLead.count({ where }),
          this.prisma.admissionLead.findMany({
            where,
            include: LEAD_INCLUDE,
            orderBy: stage === 'Enrolled' ? [{ enrolledAt: 'desc' }] : [{ nextActionAt: { sort: 'asc', nulls: 'last' } }, { score: 'desc' }, { createdAt: 'asc' }],
            take: 50,
          }),
        ]);
        return { stage, count, rows };
      }),
    );
    const mapped = await this.leads.leadRows(cols.flatMap((c) => c.rows));
    const byId = new Map(mapped.map((l) => [l.id, l]));
    return cols.map((c) => ({ stage: c.stage, count: c.count, leads: c.rows.map((r) => byId.get(r.id)!) }));
  }

  @Get('enquiries/:code')
  @RequirePermissions(...READ)
  async profile(@Param('code') code: string, @CurrentUser() user: AuthUser) {
    const found = await this.leads.findLead(code, user);
    const lead = await this.prisma.admissionLead.findUniqueOrThrow({
      where: { id: found.id },
      include: {
        ...LEAD_INCLUDE,
        history: { orderBy: [{ changedAt: 'desc' }, { id: 'desc' }] },
        followUps: true,
        communications: { orderBy: { occurredAt: 'desc' }, take: 100 },
        referrals: { orderBy: { createdAt: 'asc' }, take: 1 },
      },
    });
    const latestApp = lead.applications[0]
      ? await this.prisma.admissionApplication.findUnique({ where: { id: lead.applications[0].id }, include: { documents: true } })
      : null;
    const [campuses, staff] = await Promise.all([
      this.leads.campusNames([lead.campusId]),
      this.leads.employeeNames([lead.counsellorId, ...lead.followUps.map((f) => f.assignedTo)]),
    ]);
    const now = Date.now();
    const scheduled = lead.followUps.filter((f) => f.status === 'Scheduled').sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    const closed = lead.followUps.filter((f) => f.status !== 'Scheduled').sort((a, b) => b.scheduledAt.getTime() - a.scheduledAt.getTime());
    const ref = lead.referrals[0];
    const row = this.leads.leadRow(lead, campuses.get(lead.campusId) ?? '', lead.counsellorId ? staff.get(lead.counsellorId) ?? lead.counsellorName : null, now);
    return {
      ...row,
      notes: lead.notes,
      stageIndex: stageIndex(lead.stage),
      referredBy: ref ? { parentId: ref.referrerGuardianId, parentName: ref.referrerName, rewardStatus: ref.rewardStatus } : null,
      history: lead.history.map((h) => ({ id: h.id, fromStage: h.fromStage, toStage: h.toStage, note: h.note, changedAt: h.changedAt.toISOString(), changedBy: h.changedByName })),
      followUps: [...scheduled, ...closed].map((f) => this.followUpView(f, staff, now)),
      communications: lead.communications.map(commView),
      application: latestApp ? this.leads.applicationView(latestApp) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  @Post('enquiries')
  @RequirePermissions('admissions.manage')
  async create(@Body() dto: CreateLeadDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    this.scope.campus(user, dto.campusId);
    const lead = await this.leads.createLead(
      {
        campusId: dto.campusId, parentName: dto.parentName, phone: dto.phone, email: dto.email, studentName: dto.studentName, studentDob: dto.studentDob,
        grade: dto.gradeApplied, curriculum: dto.curriculum, source: dto.source, campaign: dto.campaign, score: dto.leadScore ?? 50,
        counsellorId: dto.counsellorId ?? null, transportRequired: dto.transportRequired, notes: dto.notes,
      },
      user,
    );
    await this.audit.record({
      user, action: 'create', module: 'admissions', entityType: 'lead', entityId: lead.id, campusId: lead.campusId,
      description: `Created lead ${lead.code} for ${lead.studentName} (${lead.grade}) via ${lead.source}`, req,
    });
    return ok({ id: lead.id, code: lead.code }, `Lead ${lead.code} created`);
  }

  @Post('enquiries/auto-assign')
  @HttpCode(200)
  @RequirePermissions('admissions.manage')
  async autoAssign(@Body() body: CampusQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const campusId = this.scope.campus(user, body?.campusId);
    const open = await this.prisma.admissionLead.findMany({
      where: { counsellorId: null, stage: { notIn: CLOSED }, ...(campusId ? { campusId } : {}) },
      orderBy: [{ score: 'desc' }, { createdAt: 'asc' }],
    });
    if (!open.length) return ok({ assigned: 0 }, 'Every open lead already has a counsellor');
    const pool = await this.leads.counsellors();
    if (!pool.length) throw badRequest('No admissions counsellors found. Add admissions or front-office staff in Workforce first.');
    const load = new Map(pool.map((c) => [c.id, c.openLeads]));
    const given = new Map<string, typeof open>();
    for (const lead of open) {
      const local = pool.filter((c) => c.campusId === lead.campusId);
      const candidates = local.length ? local : pool;
      const pick = candidates.reduce((best, c) => ((load.get(c.id) ?? 0) < (load.get(best.id) ?? 0) ? c : best), candidates[0]);
      load.set(pick.id, (load.get(pick.id) ?? 0) + 1);
      given.set(pick.id, [...(given.get(pick.id) ?? []), lead]);
      await this.prisma.admissionLead.update({ where: { id: lead.id }, data: { counsellorId: pick.id, counsellorName: pick.fullName, assignedAt: new Date() } });
      const fus = await this.prisma.admissionFollowUp.findMany({ where: { leadId: lead.id, status: 'Scheduled', assignedTo: null } });
      for (const fu of fus) await this.leads.reassignFollowUp(fu, pick.id, user);
    }
    let notified = 0;
    for (const [counsellorId, leads] of given) if (await this.leads.notifyAssigned(counsellorId, leads)) notified++;
    await this.audit.record({
      user, action: 'update', module: 'admissions', entityType: 'lead', campusId: campusId ?? null,
      description: `Auto-assigned ${open.length} lead${open.length === 1 ? '' : 's'} to ${given.size} counsellor${given.size === 1 ? '' : 's'}`,
      metadata: Object.fromEntries([...given].map(([id, l]) => [id, l.map((x) => x.code)])), req,
    });
    return ok({ assigned: open.length, counsellors: given.size, notified }, `Assigned ${open.length} lead${open.length === 1 ? '' : 's'} to ${given.size} counsellor${given.size === 1 ? '' : 's'}`);
  }

  @Post('enquiries/:code/stage')
  @HttpCode(200)
  @RequirePermissions('admissions.manage')
  async stage(@Param('code') code: string, @Body() dto: StageDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const lead = await this.leads.findLead(code, user);
    if (lead.stage === 'Enrolled') throw badRequest('This lead is enrolled; its stage can no longer change');
    if (dto.stage === 'Enrolled') throw fieldError('stage', 'Enrol the student from the application to close the lead as Enrolled');
    if (dto.stage === lead.stage) throw fieldError('stage', `The lead is already at ${lead.stage}`);
    const lostReason = dto.lostReason?.trim() ?? '';
    if (dto.stage === 'Lost' && lostReason.length < 3) throw fieldError('lostReason', 'Give a reason for closing the lead');
    let note = dto.note.trim();
    if (['Application', 'Assessment', 'Offer'].includes(dto.stage)) {
      const { app, created } = await this.leads.openApplication(lead, user);
      if (created) {
        note = `${note} (application ${app.applicationNo} opened)`;
        await this.audit.record({
          user, action: 'create', module: 'admissions', entityType: 'application', entityId: app.id, campusId: lead.campusId,
          description: `Opened application ${app.applicationNo} for ${lead.studentName} (${lead.code})`, req,
        });
      }
    }
    await this.leads.moveStage(lead, dto.stage, note, user, { lostReason: dto.stage === 'Lost' ? lostReason : null });
    if (dto.stage === 'Lost') {
      await this.prisma.admissionApplication.updateMany({
        where: { leadId: lead.id, status: { in: APP_LIVE } },
        data: { status: 'Withdrawn', decidedAt: new Date(), decidedById: user.id, decidedByName: user.fullName },
      });
    }
    await this.audit.record({
      user, action: 'update', module: 'admissions', entityType: 'lead', entityId: lead.id, campusId: lead.campusId,
      description: `Moved lead ${lead.code} from ${lead.stage} to ${dto.stage}${dto.stage === 'Lost' ? ` (${lostReason})` : ''}`,
      metadata: { note: dto.note.trim() }, req,
    });
    const message = dto.stage === 'Lost' ? `Lead ${lead.code} closed as lost` : lead.stage === 'Lost' ? `Lead ${lead.code} reopened` : `Lead moved to ${dto.stage}`;
    return ok({ code: lead.code, stage: dto.stage }, message);
  }

  @Post('enquiries/:code/assign')
  @HttpCode(200)
  @RequirePermissions('admissions.manage')
  async assign(@Param('code') code: string, @Body() dto: AssignDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const lead = await this.leads.findLead(code, user);
    if (CLOSED.includes(lead.stage)) throw badRequest(`This lead is ${lead.stage.toLowerCase()}; reopen it before reassigning`);
    const emp = dto.counsellorId ? await this.leads.employee(dto.counsellorId, 'counsellorId') : null;
    if ((emp?.id ?? null) === lead.counsellorId) return ok({ counsellor: emp?.fullName ?? null, notified: false }, 'No change');
    await this.prisma.admissionLead.update({
      where: { id: lead.id },
      data: { counsellorId: emp?.id ?? null, counsellorName: emp?.fullName ?? null, assignedAt: emp ? new Date() : null },
    });
    if (emp) {
      const fus = await this.prisma.admissionFollowUp.findMany({
        where: { leadId: lead.id, status: 'Scheduled', OR: [{ assignedTo: null }, ...(lead.counsellorId ? [{ assignedTo: lead.counsellorId }] : [])] },
      });
      for (const fu of fus) await this.leads.reassignFollowUp(fu, emp.id, user);
      await this.leads.refreshNext(lead.id);
    }
    const notified = emp ? await this.leads.notifyAssigned(emp.id, [lead]) : false;
    const before = lead.counsellorName ?? 'unassigned';
    await this.audit.record({
      user, action: 'update', module: 'admissions', entityType: 'lead', entityId: lead.id, campusId: lead.campusId,
      description: `Counsellor for ${lead.code}: ${before} → ${emp?.fullName ?? 'unassigned'}`, req,
    });
    return ok({ counsellor: emp?.fullName ?? null, notified }, emp ? `Assigned to ${emp.fullName}` : 'Counsellor removed');
  }

  @Post('enquiries/:code/follow-ups')
  @RequirePermissions('admissions.manage')
  async addFollowUp(@Param('code') code: string, @Body() dto: FollowUpDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const lead = await this.leads.findLead(code, user);
    const visit = dto.type === VISIT;
    const notes = dto.notes?.trim() || (visit ? 'Campus tour and counsellor meeting' : '');
    if (!visit && notes.length < 2) throw fieldError('notes', 'Say what the follow-up is for');
    const fu = await this.leads.scheduleFollowUp(lead, { type: dto.type, scheduledAt: new Date(dto.scheduledAt), notes, assignedTo: dto.assignedTo ?? null }, user);
    await this.audit.record({
      user, action: 'create', module: 'admissions', entityType: 'follow_up', entityId: fu.id, campusId: lead.campusId,
      description: `Scheduled ${visit ? 'a campus visit' : `a ${dto.type.toLowerCase()} follow-up`} for ${lead.code}`, req,
    });
    const staff = await this.leads.employeeNames([fu.assignedTo]);
    return ok(this.followUpView(fu, staff), visit ? 'Campus visit scheduled' : 'Follow-up scheduled');
  }

  @Post('enquiries/:code/communications')
  @RequirePermissions('admissions.manage')
  async logCommunication(@Param('code') code: string, @Body() dto: LeadCommunicationDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    let lead = await this.leads.findLead(code, user);
    const isNote = dto.channel === 'Note';
    const status = isNote ? 'Internal' : dto.status ?? 'Completed';
    const comm = await this.prisma.crmCommunication.create({
      data: {
        leadId: lead.id, counterpart: lead.parentName, channel: dto.channel, direction: isNote ? 'Internal' : 'Outbound',
        subject: dto.subject.trim(), body: dto.body?.trim() || null, status, sentById: user.id, sentByName: user.fullName,
      },
    });
    if (!isNote && status !== 'No answer') {
      if (!lead.firstContactAt) lead = await this.prisma.admissionLead.update({ where: { id: lead.id }, data: { firstContactAt: new Date() } });
      if (lead.stage === 'New Lead') await this.leads.moveStage(lead, 'Contacted', `${dto.channel}: ${dto.subject.trim()}`, user);
    }
    await this.audit.record({
      user, action: 'create', module: 'admissions', entityType: 'communication', entityId: comm.id, campusId: lead.campusId,
      description: `${isNote ? 'Added a note to' : `Logged a ${dto.channel.toLowerCase()} with`} ${lead.code}`, req,
    });
    return ok(commView(comm), isNote ? 'Note added' : dto.channel === 'Call' ? 'Call logged' : 'Communication logged');
  }

  // -------------------------------------------------------------------------
  // Follow-ups and visits
  // -------------------------------------------------------------------------

  @Patch('follow-ups/:id')
  @RequirePermissions('admissions.manage')
  async updateFollowUp(@Param('id') id: string, @Body() dto: FollowUpPatchDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertId(id, 'Follow-up');
    let fu = await this.prisma.admissionFollowUp.findUnique({ where: { id } });
    if (!fu) throw notFound('Follow-up');
    const lead = await this.leads.findLead(fu.leadId, user);
    const visit = fu.type === VISIT;
    if (dto.assignedTo === undefined && !dto.status) throw badRequest('Nothing to change');
    let message = 'Follow-up updated';
    if (dto.assignedTo !== undefined) {
      if (fu.status !== 'Scheduled') throw badRequest(`This ${visit ? 'visit' : 'follow-up'} is already ${fu.status.toLowerCase()}`);
      const before = fu.assignedName ?? 'nobody';
      fu = await this.leads.reassignFollowUp(fu, dto.assignedTo, user);
      await this.audit.record({
        user, action: 'update', module: 'admissions', entityType: 'follow_up', entityId: fu.id, campusId: lead.campusId,
        description: `${visit ? 'Visit host' : 'Follow-up owner'} for ${lead.code}: ${before} → ${fu.assignedName ?? 'nobody'}`, req,
      });
      message = visit ? 'Host updated' : 'Follow-up reassigned';
    }
    if (dto.status) {
      fu = await this.leads.closeFollowUp(fu, dto.status, dto.outcome?.trim() || null, dto.notes?.trim() || null, user);
      await this.audit.record({
        user, action: 'update', module: 'admissions', entityType: 'follow_up', entityId: fu.id, campusId: lead.campusId,
        description: `${visit ? 'Campus visit' : `${fu.type} follow-up`} for ${lead.code} marked ${dto.status.toLowerCase()}${fu.outcome ? `: ${fu.outcome}` : ''}`, req,
      });
      message = dto.status === 'Completed'
        ? (visit ? 'Visit completed' : 'Follow-up completed')
        : dto.status === 'Missed' ? (visit ? 'No-show recorded' : 'Follow-up marked missed') : (visit ? 'Visit cancelled' : 'Follow-up cancelled');
    }
    const staff = await this.leads.employeeNames([fu.assignedTo]);
    return ok(this.followUpView(fu, staff), message);
  }

  @Get('visits')
  @RequirePermissions(...READ)
  async visits(@Query() q: VisitQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.scope.campus(user, q.campusId);
    const today = dayStart();
    const ws = weekStart();
    const and: Prisma.AdmissionFollowUpWhereInput[] = [{ type: VISIT }];
    if (campusId) and.push({ lead: { campusId } });
    const range = q.range || 'week';
    if (range === 'week') and.push({ scheduledAt: { gte: ws, lt: new Date(ws.getTime() + 7 * DAY) } });
    else if (range === 'upcoming') and.push({ scheduledAt: { gte: today } });
    else if (range === 'past') and.push({ scheduledAt: { lt: today } });
    if (q.status) and.push({ status: q.status });
    if (q.unhosted === 'true') and.push({ assignedTo: null });
    if (q.q) {
      const t = q.q.trim();
      and.push({ lead: { OR: [{ parentName: like(t) }, { studentName: like(t) }, { code: like(t) }, { phone: like(t) }] } });
    }
    const where: Prisma.AdmissionFollowUpWhereInput = { AND: and };
    const orderBy = [...sortBy(q.sort, q.dir, VISIT_SORT, 'when'), { scheduledAt: 'asc' as const }];
    const [rows, total] = await Promise.all([
      this.prisma.admissionFollowUp.findMany({ where, include: { lead: true }, orderBy, skip: p.skip, take: p.take }),
      this.prisma.admissionFollowUp.count({ where }),
    ]);
    const [campuses, staff] = await Promise.all([this.leads.campusNames(rows.map((r) => r.lead.campusId)), this.leads.employeeNames(rows.map((r) => r.assignedTo))]);
    const now = Date.now();
    return paged(
      rows.map((v) => ({
        id: v.id,
        scheduledAt: v.scheduledAt.toISOString(),
        completedAt: iso(v.completedAt),
        status: v.status,
        outcome: v.outcome,
        notes: v.notes,
        hostId: v.assignedTo,
        host: v.assignedTo ? staff.get(v.assignedTo) ?? v.assignedName : null,
        overdue: v.status === 'Scheduled' && v.scheduledAt.getTime() < now,
        enquiryId: v.leadId,
        code: v.lead.code,
        family: v.lead.parentName,
        studentName: v.lead.studentName,
        grade: v.lead.grade,
        stage: v.lead.stage,
        phone: v.lead.phone,
        campusName: campuses.get(v.lead.campusId) ?? '',
      })),
      total,
      p,
    );
  }

  @Get('visits/summary')
  @RequirePermissions(...READ)
  async visitSummary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const base: Prisma.AdmissionFollowUpWhereInput = { type: VISIT, ...(campusId ? { lead: { campusId } } : {}) };
    const now = new Date();
    const ws = weekStart(now);
    const week = { gte: ws, lt: new Date(ws.getTime() + 7 * DAY) };
    const yearStart = await this.leads.yearStart();
    const since90 = new Date(now.getTime() - 90 * DAY);
    const [thisWeek, needHost, upcoming, completed, visitedLeads, closedYear, closed90] = await Promise.all([
      this.prisma.admissionFollowUp.count({ where: { ...base, scheduledAt: week, status: { not: 'Cancelled' } } }),
      this.prisma.admissionFollowUp.count({ where: { ...base, scheduledAt: week, status: 'Scheduled', assignedTo: null } }),
      this.prisma.admissionFollowUp.count({ where: { ...base, status: 'Scheduled', scheduledAt: { gte: now } } }),
      this.prisma.admissionFollowUp.count({ where: { ...base, status: 'Completed', scheduledAt: { gte: yearStart } } }),
      this.prisma.admissionFollowUp.findMany({ where: { ...base, status: 'Completed', scheduledAt: { gte: yearStart } }, distinct: ['leadId'], select: { leadId: true } }),
      this.prisma.admissionFollowUp.groupBy({ by: ['status'], where: { ...base, status: { in: ['Completed', 'Missed'] }, scheduledAt: { gte: yearStart } }, _count: { _all: true } }),
      this.prisma.admissionFollowUp.groupBy({ by: ['status'], where: { ...base, status: { in: ['Completed', 'Missed'] }, scheduledAt: { gte: since90 } }, _count: { _all: true } }),
    ]);
    const applied = visitedLeads.length
      ? await this.prisma.admissionApplication.findMany({ where: { leadId: { in: visitedLeads.map((v) => v.leadId) } }, distinct: ['leadId'], select: { leadId: true } })
      : [];
    const rate = (g: { status: string; _count: { _all: number } }[]) => {
      const missed = g.find((x) => x.status === 'Missed')?._count._all ?? 0;
      const total = g.reduce((n, x) => n + x._count._all, 0);
      return { value: pct(missed, total), total };
    };
    const year = rate(closedYear);
    const recent = rate(closed90);
    return {
      thisWeek,
      needHost,
      upcoming,
      completed,
      visitToApplication: pct(applied.length, visitedLeads.length),
      noShowRate: recent.total ? recent.value : year.value,
      noShowDelta: recent.total && year.total ? recent.value - year.value : null,
    };
  }

  @Post('visits')
  @RequirePermissions('admissions.manage')
  async scheduleVisit(@Body() dto: VisitDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const lead = await this.prisma.admissionLead.findUnique({ where: { id: dto.enquiryId } });
    if (!lead) throw fieldError('enquiryId', 'Choose a lead');
    this.scope.campus(user, lead.campusId);
    const fu = await this.leads.scheduleFollowUp(
      lead,
      { type: VISIT, scheduledAt: new Date(dto.scheduledAt), notes: dto.notes?.trim() || 'Campus tour and counsellor meeting', assignedTo: dto.hostId ?? null },
      user,
    );
    await this.audit.record({
      user, action: 'create', module: 'admissions', entityType: 'follow_up', entityId: fu.id, campusId: lead.campusId,
      description: `Scheduled a campus visit for ${lead.code} (${lead.parentName})`, req,
    });
    const staff = await this.leads.employeeNames([fu.assignedTo]);
    return ok(this.followUpView(fu, staff), 'Campus visit scheduled');
  }

  // -------------------------------------------------------------------------

  private followUpView(f: AdmissionFollowUp, staff: Map<string, string>, now = Date.now()) {
    return {
      id: f.id,
      type: f.type,
      scheduledAt: f.scheduledAt.toISOString(),
      completedAt: iso(f.completedAt),
      outcome: f.outcome,
      notes: f.notes,
      status: f.status as 'Scheduled' | 'Completed' | 'Missed' | 'Cancelled',
      assignedTo: f.assignedTo,
      assignedName: f.assignedTo ? staff.get(f.assignedTo) ?? f.assignedName : null,
      overdue: f.status === 'Scheduled' && f.scheduledAt.getTime() < now,
    };
  }

  private leadWhere(q: LeadQuery, user: AuthUser): Prisma.AdmissionLeadWhereInput {
    const campusId = this.scope.campus(user, q.campusId);
    const and: Prisma.AdmissionLeadWhereInput[] = [];
    if (campusId) and.push({ campusId });
    if (q.stage) and.push({ stage: q.stage });
    if (q.source) and.push({ source: q.source });
    if (q.counsellorId === 'unassigned') and.push({ counsellorId: null });
    else if (q.counsellorId) and.push(UUID.test(q.counsellorId) ? { counsellorId: q.counsellorId } : { id: { in: [] } });
    if (q.open === 'true') and.push({ stage: { notIn: CLOSED } });
    if (q.overdue === 'true') and.push({ stage: { notIn: CLOSED }, nextActionAt: { lt: new Date() } });
    if (q.q?.trim()) {
      const t = q.q.trim();
      const digits = t.replace(/\D/g, '');
      and.push({
        OR: [
          { studentName: like(t) }, { parentName: like(t) }, { code: like(t) }, { phone: like(t) }, { email: like(t) }, { campaign: like(t) },
          ...(digits.length >= 4 && digits.length === t.replace(/[\s+-]/g, '').length ? [{ phoneKey: { contains: digits.slice(-10) } }] : []),
        ],
      });
    }
    return and.length ? { AND: and } : {};
  }
}
