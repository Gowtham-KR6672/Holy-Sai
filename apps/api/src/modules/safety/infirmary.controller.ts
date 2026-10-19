import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Prisma, SafetyInfirmaryVisit } from '@prisma/client';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { fieldError, notFound } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { isDate, OUTCOMES, SafetyContext, SENSITIVE, sortRows, type StudentInfo } from './safety.util';

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class VisitQuery extends ListQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use a YYYY-MM-DD date' }) date?: string;
  @IsOptional() @IsIn(OUTCOMES) outcome?: string;
}

class CreateVisitDto {
  @IsUUID('all', { message: 'Choose the student' }) studentId: string;
  @IsString() @MinLength(2, { message: 'Enter the reason for the visit' }) @MaxLength(200) reason: string;
  @IsIn(OUTCOMES, { message: 'Choose the outcome' }) outcome: string;
  @IsOptional() @IsBoolean() parentInformed?: boolean;
  @IsDateString({}, { message: 'Enter the time of the visit' }) visitedAt: string;
  @IsOptional() @IsString() @MaxLength(500) actionTaken?: string;
}

class UpdateVisitDto {
  @IsOptional() @IsIn(OUTCOMES, { message: 'Choose the outcome' }) outcome?: string;
  @IsOptional() @IsBoolean() parentInformed?: boolean;
  @IsOptional() @IsString() @MaxLength(500) actionTaken?: string;
}

const ENTITY = 'infirmary_visit';

@Controller('infirmary')
export class InfirmaryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: SafetyContext,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  private async rows(list: SafetyInfirmaryVisit[]) {
    const students = await this.ctx.students(list.map((v) => v.studentId));
    return list.map((v) => {
      const s = students.get(v.studentId);
      return {
        id: v.id,
        visitedAt: v.visitedAt.toISOString(),
        reason: v.reason,
        actionTaken: v.actionTaken,
        outcome: v.outcome,
        parentInformed: v.parentInformed,
        attendedBy: v.attendedByName,
        studentId: v.studentId,
        studentName: s?.fullName ?? 'Unknown student',
        admissionNo: s?.admissionNo ?? '',
        grade: s?.grade ?? null,
        section: s?.section ?? null,
      };
    });
  }

  @Get('visits')
  @RequirePermissions('safety.read', 'safety.manage')
  async list(@Query() q: VisitQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const clock = await this.ctx.clock();
    const date = isDate(q.date) ? q.date : clock.today();
    const { start, end } = clock.bounds(date);
    const recordWhere = await this.ctx.recordWhere(user, q.campusId);
    const term = q.q?.trim();
    const where: Prisma.SafetyInfirmaryVisitWhereInput = {
      ...recordWhere,
      visitedAt: { gte: start, lt: end },
      ...(q.outcome ? { outcome: q.outcome } : {}),
    };
    if (term) {
      const ids = await this.ctx.matchingStudentIds(user, term, q.campusId);
      where.OR = [{ reason: { contains: term, mode: 'insensitive' } }, { actionTaken: { contains: term, mode: 'insensitive' } }, { studentId: { in: ids } }];
    }
    const list = await this.prisma.safetyInfirmaryVisit.findMany({ where, orderBy: { visitedAt: 'desc' }, take: 5000 });
    const rows = await this.rows(list);
    const sorted = sortRows(rows, q.sort, q.dir, {
      student: (r) => r.studentName,
      time: (r) => r.visitedAt,
      reason: (r) => r.reason,
      outcome: (r) => r.outcome,
    }, 'time', 'desc');
    return paged(sorted.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  @Get('summary')
  @RequirePermissions('safety.read', 'safety.manage')
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const clock = await this.ctx.clock();
    const today = clock.today();
    const { start, end } = clock.bounds(today);
    const now = new Date();
    const recordWhere = await this.ctx.recordWhere(user, q.campusId);
    const studentWhere = await this.ctx.studentWhere(user, q.campusId);
    const monthStart = clock.at(`${today.slice(0, 7)}-01`);
    const [y, m] = today.split('-').map(Number);
    const prevMonth = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
    const prevStart = clock.at(prevMonth);
    const prevEnd = new Date(prevStart.getTime() + (now.getTime() - monthStart.getTime()));
    const term = await this.ctx.term(clock);

    const [todays, thisMonth, lastMonthToDate, medicalOnFile, termVisits] = await Promise.all([
      this.prisma.safetyInfirmaryVisit.findMany({ where: { ...recordWhere, visitedAt: { gte: start, lt: end } }, select: { outcome: true, parentInformed: true } }),
      this.prisma.safetyInfirmaryVisit.count({ where: { ...recordWhere, visitedAt: { gte: monthStart, lt: end } } }),
      this.prisma.safetyInfirmaryVisit.count({ where: { ...recordWhere, visitedAt: { gte: prevStart, lt: prevEnd < monthStart ? prevEnd : monthStart } } }),
      this.prisma.student.count({ where: { AND: [studentWhere, { status: 'active' }, { medicalNotes: { not: null } }, { NOT: { medicalNotes: '' } }] } }),
      this.prisma.safetyInfirmaryVisit.findMany({ where: { ...recordWhere, visitedAt: { gte: term.start, lt: term.end } }, select: { reason: true } }),
    ]);

    const reasons = new Map<string, { label: string; value: number }>();
    for (const v of termVisits) {
      const key = v.reason.trim().toLowerCase();
      const r = reasons.get(key);
      if (r) r.value++;
      else reasons.set(key, { label: v.reason.trim().charAt(0).toUpperCase() + v.reason.trim().slice(1), value: 1 });
    }
    return {
      today: todays.length,
      sentHome: todays.filter((v) => v.outcome === 'Sent home').length,
      awaitingPickup: todays.filter((v) => v.outcome === 'Awaiting pickup').length,
      parentNotInformed: todays.filter((v) => !v.parentInformed).length,
      thisMonth,
      lastMonthToDate,
      monthDeltaPct: lastMonthToDate ? Math.round(((thisMonth - lastMonthToDate) / lastMonthToDate) * 100) : null,
      medicalOnFile,
      reasons: [...reasons.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)).slice(0, 6),
    };
  }

  @Post('visits')
  @RequirePermissions('safety.manage')
  async create(@Body() dto: CreateVisitDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const visitedAt = new Date(dto.visitedAt);
    if (Number.isNaN(visitedAt.getTime()) || visitedAt.getTime() > Date.now() + 60_000) throw fieldError('visitedAt', 'The time cannot be in the future');
    const student = await this.ctx.assertStudent(user, dto.studentId);
    const visit = await this.prisma.safetyInfirmaryVisit.create({
      data: {
        campusId: student.campusId,
        studentId: student.id,
        visitedAt,
        reason: dto.reason.trim(),
        actionTaken: dto.actionTaken?.trim() || null,
        outcome: dto.outcome,
        parentInformed: !!dto.parentInformed,
        parentInformedAt: dto.parentInformed ? new Date() : null,
        attendedById: user.id,
        attendedByName: user.fullName,
      },
    });
    if (visit.parentInformed) await this.informParents(visit, student, 'new');
    if (visit.outcome === 'Referred to hospital') await this.alertReferral(visit, student);
    await this.audit.record({
      user, action: 'create', module: 'safety', entityType: ENTITY, entityId: visit.id, campusId: student.campusId, sensitive: true, req,
      description: `Logged an infirmary visit for ${student.fullName} (${visit.outcome})${visit.parentInformed ? ', parents informed' : ''}`,
    });
    const [row] = await this.rows([visit]);
    return ok(row, visit.parentInformed ? 'Visit logged — parents informed' : 'Visit logged');
  }

  @Patch('visits/:id')
  @RequirePermissions('safety.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVisitDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const before = await this.prisma.safetyInfirmaryVisit.findUnique({ where: { id } });
    if (!before) throw notFound('Visit');
    const student = await this.ctx.assertStudent(user, before.studentId);
    const data: Prisma.SafetyInfirmaryVisitUpdateInput = {};
    const notes: string[] = [];
    if (dto.outcome && dto.outcome !== before.outcome) {
      data.outcome = dto.outcome;
      notes.push(`outcome ${before.outcome} → ${dto.outcome}`);
    }
    if (dto.actionTaken !== undefined && (dto.actionTaken.trim() || null) !== before.actionTaken) {
      data.actionTaken = dto.actionTaken.trim() || null;
      notes.push('action updated');
    }
    const informNow = dto.parentInformed === true && !before.parentInformed;
    if (informNow) {
      Object.assign(data, { parentInformed: true, parentInformedAt: new Date() });
      notes.push('parents informed');
    }
    if (!notes.length) {
      const [same] = await this.rows([before]);
      return ok(same, 'No changes to save');
    }
    const visit = await this.prisma.safetyInfirmaryVisit.update({ where: { id }, data });
    if (informNow) await this.informParents(visit, student, 'new');
    else if (visit.parentInformed && dto.outcome && dto.outcome !== before.outcome) await this.informParents(visit, student, 'update');
    if (visit.outcome === 'Referred to hospital' && before.outcome !== 'Referred to hospital') await this.alertReferral(visit, student);
    await this.audit.record({
      user, action: 'update', module: 'safety', entityType: ENTITY, entityId: id, campusId: student.campusId, sensitive: true, req,
      description: `Updated the infirmary visit of ${student.fullName}: ${notes.join(', ')}`,
    });
    const [row] = await this.rows([visit]);
    return ok(row, informNow ? 'Visit updated — parents informed' : 'Visit updated');
  }

  private async informParents(v: SafetyInfirmaryVisit, s: StudentInfo, kind: 'new' | 'update') {
    const clock = await this.ctx.clock();
    const ask = v.outcome === 'Awaiting pickup' ? ' Please arrange to collect your child.' : v.outcome === 'Referred to hospital' ? ' Please call the school office now.' : '';
    await this.notifications.notifyGuardians(s.id, {
      category: v.outcome === 'Referred to hospital' ? 'Critical' : 'Attention',
      topic: 'safety',
      module: 'safety',
      title: kind === 'new' ? `${s.firstName} visited the infirmary` : `Infirmary update for ${s.firstName}`,
      body: `${v.reason} at ${clock.time(v.visitedAt)}.${v.actionTaken ? ` Action taken: ${v.actionTaken}.` : ''} Outcome: ${v.outcome}.${ask}`,
      route: '/parent-360?tab=safety',
      campusId: s.campusId,
      deliver: true,
    });
  }

  private async alertReferral(v: SafetyInfirmaryVisit, s: StudentInfo) {
    await this.notifications.notifyPermission(SENSITIVE, {
      category: 'Critical',
      topic: 'safety',
      module: 'safety',
      title: `${s.fullName} referred to hospital`,
      body: `From the infirmary: ${v.reason}.${v.parentInformed ? ' Parents informed.' : ' Parents not yet informed.'}`,
      route: '/infirmary',
      campusId: s.campusId,
    });
  }
}
