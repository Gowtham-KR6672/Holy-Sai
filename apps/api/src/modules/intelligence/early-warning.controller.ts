import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, conflict, fieldError, notFound } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EarlyWarningService, OPEN_SIGNAL, type StudentState } from './early-warning.service';
import { addDays, asDate, assertUuid, csvFile, dayKey, isUuid, maxRisk, RISK_LEVELS, riskRank, schoolToday, STAGES } from './intel.util';
import { IntelPeople } from './people.service';
import { StudentExtrasService } from './student-extras.service';

const READ = ['earlywarning.read', 'earlywarning.manage'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INTERVENTION_BY_STAGE: Record<number, string> = { 2: 'Planned', 3: 'Active', 4: 'Monitoring' };

class SignalsQuery extends ListQuery {
  @IsOptional() @IsIn(['awaiting', 'open', 'closed', 'dismissed']) status?: string;
}

class StudentsQuery extends ListQuery {
  @IsOptional() @IsString() grade?: string;
  @IsOptional() @IsString() risk?: string;
  @IsOptional() @IsString() intervention?: string;
}

class ReviewDto {
  @IsIn(['accept', 'dismiss'], { message: 'Choose accept or dismiss' }) decision: 'accept' | 'dismiss';
  @IsOptional() @IsString() @MaxLength(1000) actionPlan?: string;
  @IsOptional() @IsString() ownerId?: string;
  @IsOptional() @Matches(DATE, { message: 'Choose a review date' }) nextReviewOn?: string;
  @IsOptional() @IsIn([...RISK_LEVELS], { message: 'Choose a risk level' }) riskLevel?: string;
  @IsOptional() @IsString() @MaxLength(2000) context?: string;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

class AdvanceDto {
  @IsString() @MaxLength(1000) note: string;
  @IsOptional() @Matches(DATE, { message: 'Choose a valid date' }) nextReviewOn?: string;
}

class CloseDto {
  @IsString() @MaxLength(1000) outcome: string;
  @IsOptional() @IsIn([...RISK_LEVELS], { message: 'Choose a risk level' }) riskLevel?: string;
}

class RunCheckDto {
  @IsOptional() @IsString() campusId?: string;
}

/** Early Warning: risk bands, signals awaiting teacher review, interventions and the signal check. */
@Controller('early-warning')
@RequirePermissions(...READ)
export class EarlyWarningController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly ew: EarlyWarningService,
    private readonly people: IntelPeople,
    private readonly extras: StudentExtrasService,
  ) {}

  private async scopedIds(user: AuthUser, campusId?: string): Promise<string[]> {
    const where: Prisma.StudentWhereInput = { AND: [await this.scope.studentWhere(user, campusId), { status: 'active' }] };
    return (await this.prisma.student.findMany({ where, select: { id: true } })).map((s) => s.id);
  }

  private async load(id: string, user: AuthUser) {
    assertUuid(id, 'Signal');
    const s = await this.prisma.earlyWarningSignal.findUnique({ where: { id } });
    if (!s) throw notFound('Signal');
    await this.scope.assertStudent(user, s.studentId);
    return s;
  }

  @Get('summary')
  async summary(@Query('campusId') campusId: string | undefined, @CurrentUser() user: AuthUser) {
    const ids = await this.scopedIds(user, campusId);
    const [states, th, termStart] = await Promise.all([this.ew.states(ids), this.ew.thresholds(), this.ew.termStart()]);
    const bands = { total: ids.length, atRisk: 0, developing: 0, watch: 0, onTrack: 0 };
    for (const id of ids) {
      const b = states.get(id)?.band ?? 'On Track';
      if (b === 'At Risk') bands.atRisk++;
      else if (b === 'Developing Risk') bands.developing++;
      else if (b === 'Watch') bands.watch++;
      else bands.onTrack++;
    }
    const signals = ids.length
      ? await this.prisma.earlyWarningSignal.findMany({
          where: { studentId: { in: ids } },
          select: { studentId: true, stage: true, decision: true, closedAt: true, reviewedAt: true, nextReviewOn: true, raisedOn: true },
        })
      : [];
    const today = schoolToday();
    const termFrom = asDate(termStart);
    const awaiting = signals.filter((s) => !s.decision && !s.closedAt);
    const open = signals.filter((s) => s.decision === 'accepted' && !s.closedAt);
    const closedThisTerm = signals.filter((s) => s.closedAt && s.closedAt >= termFrom).length;
    const students = (list: typeof signals) => new Set(list.map((s) => s.studentId)).size;
    const stages = STAGES.map((label, stage) => ({
      stage,
      label,
      count: stage === 5 ? closedThisTerm : stage <= 1 ? students(awaiting.filter((s) => s.stage === stage)) : students(open.filter((s) => s.stage === stage)),
    }));
    const weekAgo = asDate(addDays(today, -7));
    return {
      bands,
      stages,
      closedThisTerm,
      reviewed: signals.filter((s) => s.decision && s.reviewedAt && s.reviewedAt >= termFrom).length,
      dismissed: signals.filter((s) => s.decision === 'dismissed' && s.reviewedAt && s.reviewedAt >= termFrom).length,
      openInterventions: open.length,
      awaitingReview: awaiting.length,
      overdueReviews: open.filter((s) => s.nextReviewOn && dayKey(s.nextReviewOn) < today).length + awaiting.filter((s) => s.raisedOn < weekAgo).length,
      termStart,
      thresholds: th,
    };
  }

  @Get('signals')
  async signals(@Query() q: SignalsQuery, @CurrentUser() user: AuthUser) {
    const ids = await this.scopedIds(user, q.campusId);
    const p = pageOf(q, 10);
    const status = q.status ?? 'open';
    const byStatus: Prisma.EarlyWarningSignalWhereInput =
      status === 'awaiting' ? { decision: null, closedAt: null }
      : status === 'closed' ? { decision: 'accepted', closedAt: { not: null } }
      : status === 'dismissed' ? { decision: 'dismissed' }
      : OPEN_SIGNAL;
    const where: Prisma.EarlyWarningSignalWhereInput = { AND: [{ studentId: { in: ids } }, byStatus] };
    const dir = q.dir ?? 'desc';
    const orderBy: Prisma.EarlyWarningSignalOrderByWithRelationInput[] =
      q.sort === 'stage' ? [{ stage: dir }, { raisedOn: 'desc' }]
      : q.sort === 'review' ? [{ nextReviewOn: dir }, { raisedOn: 'desc' }]
      : status === 'closed' ? [{ closedAt: dir }] : [{ raisedOn: dir }, { createdAt: dir }];
    const [rows, total] = await Promise.all([
      this.prisma.earlyWarningSignal.findMany({ where, orderBy, skip: p.skip, take: p.take }),
      this.prisma.earlyWarningSignal.count({ where }),
    ]);
    return paged(await this.ew.signalRows(rows), total, p);
  }

  @Get('signals/:id')
  async detail(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    let s = await this.load(id, user);
    // Opening a new signal to review it starts the teacher review (stage 1).
    if (user.permissions.has('earlywarning.manage') && !s.decision && !s.closedAt && s.stage === 0) {
      s = await this.prisma.earlyWarningSignal.update({
        where: { id: s.id },
        data: { stage: 1, reviewStartedAt: new Date(), events: { create: { studentId: s.studentId, action: 'review', description: `Teacher review started by ${user.fullName}`, byId: user.id, byName: user.fullName } } },
      });
    }
    const [row] = await this.ew.signalRows([s]);
    const [states, th, student, events, contexts, behaviour, observations] = await Promise.all([
      this.ew.states([s.studentId]),
      this.ew.thresholds(),
      this.prisma.student.findUnique({
        where: { id: s.studentId },
        select: { section: { select: { name: true, classTeacherId: true, class: { select: { name: true } } } } },
      }),
      this.prisma.earlyWarningEvent.findMany({ where: { signalId: s.id }, orderBy: { at: 'desc' } }),
      this.prisma.earlyWarningEvent.findMany({ where: { studentId: s.studentId, action: 'context' }, orderBy: { at: 'desc' }, take: 10 }),
      this.extras.behaviour([s.studentId]),
      this.extras.observations([s.studentId]),
    ]);
    const st: StudentState | undefined = states.get(s.studentId);
    const teacherId = student?.section.classTeacherId ?? null;
    const teacherName = teacherId ? (await this.people.employeeNames([teacherId])).get(teacherId) : undefined;
    const since60 = addDays(schoolToday(), -60);
    if (s.signalType === 'wellbeing') {
      await this.audit.record({
        user, action: 'view', module: 'earlywarning', entityType: 'ew_signal', entityId: s.id, campusId: s.campusId, sensitive: true, req,
        description: `Viewed wellbeing signal ${s.code}`,
      });
    }
    return {
      ...row,
      ownerId: s.ownerId ?? teacherId,
      riskLevel: s.riskLevel,
      context: s.context,
      student: st
        ? {
            attendance: st.attendancePct,
            average: st.average,
            trend: st.trend ?? 0,
            classTeacherSection: student ? `${student.section.class.name}${student.section.name}${teacherName ? ` · class teacher ${teacherName}` : ''}` : '',
          }
        : null,
      participation: {
        activities: st?.activities ?? 0,
        concerns: st?.concerns60 ?? 0,
        positives: st?.positives60 ?? 0,
        absent30: st?.absent30 ?? 0,
        late30: st?.late30 ?? 0,
      },
      behaviour: behaviour.filter((b) => (b.date ?? '') >= since60).slice(0, 10).map((b) => ({ date: b.date ?? '', type: b.type, note: b.note, by: b.by })),
      observations: [
        ...observations.map((o) => ({ date: o.date ?? '', text: o.text, by: o.by })),
        ...contexts.filter((c) => !observations.some((o) => o.text === c.description)).map((c) => ({ date: dayKey(c.at), text: c.description, by: c.byName })),
      ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10),
      history: events.map((e) => ({ at: e.at.toISOString(), by: e.byName, action: e.action, description: e.description })),
      thresholds: th,
    };
  }

  @Post('signals/:id/review')
  @HttpCode(200)
  @RequirePermissions('earlywarning.manage')
  async review(@Param('id') id: string, @Body() dto: ReviewDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const s = await this.load(id, user);
    if (s.decision || s.closedAt) throw conflict(`This signal has already been ${s.decision ?? 'closed'}${s.reviewedByName ? ` by ${s.reviewedByName}` : ''}`);
    const context = dto.context?.trim() || null;
    const now = new Date();
    const events: Prisma.EarlyWarningEventCreateWithoutSignalInput[] = [];
    if (context) {
      events.push({ studentId: s.studentId, action: 'context', description: context, byId: user.id, byName: user.fullName });
      // Also kept as a teacher observation on Student 360.
      await this.extras.addObservation(user, s.studentId, s.campusId, context);
    }

    if (dto.decision === 'dismiss') {
      const reason = dto.reason?.trim() ?? '';
      if (reason.length < 5) throw fieldError('reason', 'Record why this signal is being dismissed');
      events.push({ studentId: s.studentId, action: 'dismiss', description: `Dismissed by ${user.fullName}: ${reason}`, byId: user.id, byName: user.fullName });
      await this.prisma.earlyWarningSignal.update({
        where: { id: s.id },
        data: { decision: 'dismissed', stage: 1, reviewedAt: now, reviewedById: user.id, reviewedByName: user.fullName, dismissReason: reason, context, events: { create: events } },
      });
      await this.notifications.completeTasksFor('ew_signal', s.id);
      await this.ew.computeStates([s.studentId]);
      await this.audit.record({
        user, action: 'reject', module: 'earlywarning', entityType: 'ew_signal', entityId: s.id, campusId: s.campusId, req,
        description: `Dismissed Early Warning ${s.code} (${s.signalType}): ${reason}`, metadata: { reason, signal: s.signal },
      });
      return ok({ id: s.id, decision: 'dismissed' }, `${s.code} dismissed — the reason is kept in the audit trail`);
    }

    const plan = dto.actionPlan?.trim() ?? '';
    if (plan.length < 5) throw fieldError('actionPlan', 'Describe the agreed support (at least 5 characters)');
    if (!dto.ownerId || !isUuid(dto.ownerId)) throw fieldError('ownerId', 'Choose who owns this intervention');
    const owner = await this.prisma.employee.findFirst({ where: { id: dto.ownerId, archivedAt: null, employmentStatus: { not: 'exited' } }, select: { id: true, fullName: true } });
    if (!owner) throw fieldError('ownerId', 'Choose who owns this intervention');
    if (!dto.nextReviewOn) throw fieldError('nextReviewOn', 'Choose a review date');
    if (dto.nextReviewOn < schoolToday()) throw fieldError('nextReviewOn', 'Choose today or a later date');

    // Band: the reviewer's choice, else automatic — an accepted signal is at least Developing Risk, and automatic never lowers it.
    const state = (await this.ew.states([s.studentId])).get(s.studentId);
    const band = dto.riskLevel ?? maxRisk(state?.band ?? 'On Track', 'Developing Risk');
    events.push({ studentId: s.studentId, action: 'approve', description: `Accepted by ${user.fullName}; intervention owned by ${owner.fullName}: ${plan}`, byId: user.id, byName: user.fullName });
    await this.prisma.earlyWarningSignal.update({
      where: { id: s.id },
      data: {
        decision: 'accepted', stage: 2, reviewedAt: now, reviewedById: user.id, reviewedByName: user.fullName, actionPlan: plan, ownerId: owner.id,
        nextReviewOn: asDate(dto.nextReviewOn), riskLevel: band, context, events: { create: events },
      },
    });
    await this.ew.setBand(s.studentId, band);

    await this.notifications.completeTasksFor('ew_signal', s.id);
    const ownerUser = (await this.people.usersOfEmployees([owner.id])).get(owner.id);
    const student = await this.prisma.student.findUnique({ where: { id: s.studentId }, select: { fullName: true } });
    if (ownerUser) {
      await this.notifications.createTask({
        title: `Intervention ${s.code}: ${student?.fullName ?? ''} — review`, module: 'earlywarning', assigneeId: ownerUser, dueOn: dto.nextReviewOn,
        priority: 'High', route: '/early-warning', entityType: 'ew_signal', entityId: s.id,
      });
      if (ownerUser !== user.id) {
        await this.notifications.notifyUsers([ownerUser], {
          category: 'Attention', topic: 'system', module: 'earlywarning', icon: 'flag', campusId: s.campusId,
          title: `You own the intervention for ${student?.fullName ?? 'a student'}`, body: `${s.code} · ${plan} · review by ${dto.nextReviewOn}`, route: '/early-warning',
        });
      }
    }
    await this.audit.record({
      user, action: 'approve', module: 'earlywarning', entityType: 'ew_signal', entityId: s.id, campusId: s.campusId, req,
      description: `Accepted Early Warning ${s.code} for ${student?.fullName ?? 'a student'}; intervention owner ${owner.fullName}, review ${dto.nextReviewOn}`,
      metadata: { actionPlan: plan, ownerId: owner.id, nextReviewOn: dto.nextReviewOn, riskLevel: dto.riskLevel ?? null },
    });
    return ok({ id: s.id, decision: 'accepted' }, `${s.code} accepted — intervention opened`);
  }

  @Post('signals/:id/advance')
  @HttpCode(200)
  @RequirePermissions('earlywarning.manage')
  async advance(@Param('id') id: string, @Body() dto: AdvanceDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const s = await this.load(id, user);
    if (s.decision !== 'accepted' || s.closedAt) throw badRequest('Only an open intervention can move on');
    if (s.stage < 2 || s.stage > 3) throw badRequest('This intervention is at follow-up — close it with an outcome');
    const note = dto.note.trim();
    if (note.length < 3) throw fieldError('note', 'Record what was done');
    if (dto.nextReviewOn && dto.nextReviewOn < schoolToday()) throw fieldError('nextReviewOn', 'Choose today or a later date');
    const to = s.stage + 1;
    await this.prisma.earlyWarningSignal.update({
      where: { id: s.id },
      data: {
        stage: to, ...(dto.nextReviewOn ? { nextReviewOn: asDate(dto.nextReviewOn) } : {}),
        events: { create: { studentId: s.studentId, action: 'advance', description: `${STAGES[s.stage]} → ${STAGES[to]}: ${note}`, byId: user.id, byName: user.fullName } },
      },
    });
    if (dto.nextReviewOn && s.ownerId) {
      await this.notifications.completeTasksFor('ew_signal', s.id);
      const ownerUser = (await this.people.usersOfEmployees([s.ownerId])).get(s.ownerId);
      if (ownerUser) {
        await this.notifications.createTask({
          title: `Intervention ${s.code}: ${STAGES[to]} — review`, module: 'earlywarning', assigneeId: ownerUser, dueOn: dto.nextReviewOn,
          priority: 'Medium', route: '/early-warning', entityType: 'ew_signal', entityId: s.id,
        });
      }
    }
    await this.audit.record({
      user, action: 'update', module: 'earlywarning', entityType: 'ew_signal', entityId: s.id, campusId: s.campusId, req,
      description: `Moved intervention ${s.code} to ${STAGES[to]}: ${note}`,
    });
    return ok({ id: s.id, stage: to }, `${s.code} moved to ${STAGES[to]}`);
  }

  @Post('signals/:id/close')
  @HttpCode(200)
  @RequirePermissions('earlywarning.manage')
  async close(@Param('id') id: string, @Body() dto: CloseDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const s = await this.load(id, user);
    if (s.decision !== 'accepted' || s.closedAt) throw badRequest('Only an open intervention can be closed');
    const outcome = dto.outcome.trim();
    if (outcome.length < 5) throw fieldError('outcome', 'Record the outcome before closing');
    await this.prisma.earlyWarningSignal.update({
      where: { id: s.id },
      data: {
        stage: 5, closedAt: new Date(), closedById: user.id, closedByName: user.fullName, outcome, riskLevel: dto.riskLevel ?? s.riskLevel,
        events: { create: { studentId: s.studentId, action: 'close', description: `Closed by ${user.fullName}: ${outcome}${dto.riskLevel ? ` · band ${dto.riskLevel}` : ''}`, byId: user.id, byName: user.fullName } },
      },
    });
    await this.notifications.completeTasksFor('ew_signal', s.id);
    if (dto.riskLevel) await this.ew.setBand(s.studentId, dto.riskLevel);
    await this.audit.record({
      user, action: 'update', module: 'earlywarning', entityType: 'ew_signal', entityId: s.id, campusId: s.campusId, req,
      description: `Closed intervention ${s.code}: ${outcome}`, metadata: { outcome, riskLevel: dto.riskLevel ?? null },
    });
    return ok({ id: s.id, stage: 5 }, `${s.code} closed with outcome`);
  }

  // ---------------------------------------------------------------------------
  // Students needing attention
  // ---------------------------------------------------------------------------

  private async studentRows(q: StudentsQuery, user: AuthUser) {
    const where: Prisma.StudentWhereInput = {
      AND: [
        await this.scope.studentWhere(user, q.campusId),
        { status: 'active' },
        q.grade ? { section: { class: { name: q.grade } } } : {},
        q.q?.trim() ? { OR: [{ fullName: { contains: q.q.trim(), mode: 'insensitive' } }, { admissionNo: { contains: q.q.trim(), mode: 'insensitive' } }] } : {},
      ],
    };
    const students = await this.prisma.student.findMany({
      where,
      select: {
        id: true, admissionNo: true, fullName: true, firstName: true, lastName: true, campusId: true, sectionId: true, house: true, photoUrl: true, risk: true,
        section: { select: { name: true, classId: true, class: { select: { name: true, gradeLevel: true } } } },
        transport: { select: { route: { select: { code: true, name: true } } } },
      },
    });
    const ids = students.map((s) => s.id);
    const [states, signals] = await Promise.all([
      this.ew.states(ids),
      ids.length ? this.prisma.earlyWarningSignal.findMany({ where: { studentId: { in: ids }, ...OPEN_SIGNAL }, orderBy: [{ raisedOn: 'desc' }] }) : Promise.resolve([]),
    ]);
    const owners = await this.people.employeeNames(signals.map((s) => s.ownerId));
    const bySignal = new Map<string, (typeof signals)[number]>();
    for (const sig of signals) {
      const cur = bySignal.get(sig.studentId);
      // The most advanced open intervention wins; otherwise the newest signal awaiting review.
      const rank = (x: typeof sig) => (x.decision === 'accepted' ? 10 + x.stage : 0);
      if (!cur || rank(sig) > rank(cur)) bySignal.set(sig.studentId, sig);
    }
    let rows = students.map((s) => {
      const st = states.get(s.id);
      const sig = bySignal.get(s.id) ?? null;
      const intervention = !sig ? 'None' : sig.decision === 'accepted' ? INTERVENTION_BY_STAGE[sig.stage] ?? 'Active' : 'Review pending';
      return {
        id: s.id, admissionNo: s.admissionNo, fullName: s.fullName, firstName: s.firstName, lastName: s.lastName,
        grade: s.section.class.name, section: s.section.name, sectionId: s.sectionId, classId: s.section.classId, campusId: s.campusId, house: s.house,
        gradeLevel: s.section.class.gradeLevel,
        today: '', attendance: st?.attendancePct ?? null, average: st?.average ?? null, trend: st?.trend ?? null,
        risk: st?.band ?? s.risk, feeStatus: st && st.feesOverdue > 0 ? 'Overdue' : '', busRoute: s.transport?.route ? `${s.transport.route.code} · ${s.transport.route.name}` : null,
        photoUrl: s.photoUrl, intervention, signalId: sig?.id ?? null, signalDecision: sig?.decision ?? null, signalCode: sig?.code ?? null,
        owner: sig?.ownerId ? owners.get(sig.ownerId) ?? null : null, signalText: sig?.signal ?? null,
      };
    });
    if (q.risk) rows = rows.filter((r) => (q.risk === 'On Track' ? r.risk === 'On Track' || r.risk === 'Watch' : r.risk === q.risk));
    else rows = rows.filter((r) => riskRank(r.risk) >= 2 || r.intervention !== 'None');
    if (q.intervention) rows = rows.filter((r) => r.intervention === q.intervention);

    const dir = q.dir === 'desc' ? -1 : 1;
    const nullsLast = (a: number | null, b: number | null) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : (a - b) * dir);
    const IORDER = ['Review pending', 'Planned', 'Active', 'Monitoring', 'None'];
    const cmp: Record<string, (a: (typeof rows)[number], b: (typeof rows)[number]) => number> = {
      name: (a, b) => a.fullName.localeCompare(b.fullName) * dir,
      grade: (a, b) => (a.gradeLevel - b.gradeLevel || a.section.localeCompare(b.section)) * dir || a.fullName.localeCompare(b.fullName),
      attendance: (a, b) => nullsLast(a.attendance, b.attendance) || a.fullName.localeCompare(b.fullName),
      trend: (a, b) => nullsLast(a.trend, b.trend) || a.fullName.localeCompare(b.fullName),
      risk: (a, b) => (riskRank(a.risk) - riskRank(b.risk)) * dir || a.fullName.localeCompare(b.fullName),
      intervention: (a, b) => (IORDER.indexOf(a.intervention) - IORDER.indexOf(b.intervention)) * dir || a.fullName.localeCompare(b.fullName),
      owner: (a, b) => (a.owner ?? '￿').localeCompare(b.owner ?? '￿') * dir,
    };
    rows.sort(cmp[q.sort ?? 'attendance'] ?? cmp.attendance);
    return rows;
  }

  @Get('students')
  async students(@Query() q: StudentsQuery, @CurrentUser() user: AuthUser) {
    const rows = await this.studentRows(q, user);
    const p = pageOf(q, 25);
    const page = rows.slice(p.skip, p.skip + p.take);
    // Today's register and fee status for the rows shown.
    const ids = page.map((r) => r.id);
    if (ids.length) {
      const [att, charges] = await Promise.all([
        this.prisma.studentAttendance.findMany({ where: { studentId: { in: ids }, date: asDate(schoolToday()) }, select: { studentId: true, status: true } }),
        this.prisma.financeCharge.groupBy({ by: ['studentId'], where: { studentId: { in: ids } }, _sum: { balance: true } }),
      ]);
      const today = new Map(att.map((a) => [a.studentId, a.status]));
      const bal = new Map(charges.map((c) => [c.studentId, Number(c._sum.balance ?? 0)]));
      for (const r of page) {
        r.today = today.get(r.id) ?? 'not_marked';
        if (!r.feeStatus) r.feeStatus = !bal.has(r.id) ? 'No fees' : (bal.get(r.id) ?? 0) > 0 ? 'Due' : 'Paid';
      }
    }
    return paged(page, rows.length, p);
  }

  @Get('export')
  async export(@Query() q: StudentsQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const rows = await this.studentRows(q, user);
    await this.audit.record({
      user, action: 'export', module: 'earlywarning', entityType: 'ew_review_list', req, campusId: this.scope.campus(user, q.campusId) ?? null,
      description: `Exported the Early Warning review list (${rows.length} students)`,
    });
    return csvFile('early-warning-review.csv', [
      { key: 'fullName', label: 'Student' }, { key: 'admissionNo', label: 'Admission no' }, { key: 'grade', label: 'Grade' }, { key: 'section', label: 'Section' },
      { key: 'attendance', label: 'Attendance %' }, { key: 'average', label: 'Latest-term average' }, { key: 'trend', label: 'Trend' }, { key: 'risk', label: 'Risk band' },
      { key: 'intervention', label: 'Intervention' }, { key: 'signalCode', label: 'Signal' }, { key: 'signalText', label: 'Signal detail' }, { key: 'owner', label: 'Owner' },
    ], rows);
  }

  @Post('run-check')
  @HttpCode(200)
  @RequirePermissions('earlywarning.manage')
  async runCheck(@Body() dto: RunCheckDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const ids = await this.scopedIds(user, dto.campusId);
    const r = await this.ew.check(ids, { id: user.id, name: user.fullName });
    await this.audit.record({
      user, action: 'create', module: 'earlywarning', entityType: 'ew_check', req, campusId: this.scope.campus(user, dto.campusId) ?? null,
      description: `Ran the Early Warning check: ${r.checked} students checked, ${r.created.length} new signals, ${r.skipped} skipped`,
      metadata: { created: r.created.map((c) => c.code) },
    });
    return ok({
      checked: r.checked,
      matched: r.matched,
      skipped: r.skipped,
      created: r.created.map((c) => ({ id: c.id, code: c.code, studentId: c.studentId, studentName: c.studentName, admissionNo: c.admissionNo, rule: c.rule, signal: c.signal })),
      rules: await this.ew.rules(),
    }, r.created.length ? `${r.created.length} new signal${r.created.length === 1 ? '' : 's'} raised for review` : 'Check complete — no new signals');
  }
}
