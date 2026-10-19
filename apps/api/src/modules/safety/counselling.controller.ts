import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Prisma, SafetyCounsellingSession } from '@prisma/client';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SafetyContext, SENSITIVE, SESSION_STATUSES, sortRows, type StudentInfo } from './safety.util';

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class SessionQuery extends ListQuery {
  @IsOptional() @IsIn(SESSION_STATUSES) status?: string;
  @IsOptional() @IsIn(['upcoming', 'past']) when?: string;
  @IsOptional() @IsUUID() studentId?: string;
}

class CreateSessionDto {
  @IsUUID('all', { message: 'Choose the student' }) studentId: string;
  @IsUUID('all', { message: 'Choose the counsellor' }) counsellorId: string;
  @IsDateString({}, { message: 'Choose a date and time' }) sessionOn: string;
  @IsString() @MinLength(3, { message: 'Enter the reason' }) @MaxLength(200) reason: string;
  @IsOptional() @IsIn(SESSION_STATUSES) status?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

class UpdateSessionDto {
  @IsOptional() @IsIn(SESSION_STATUSES) status?: string;
  @IsOptional() @IsDateString({}, { message: 'Choose a date and time' }) sessionOn?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

const ENTITY = 'counselling_session';
const STATUS_ORDER: Record<string, number> = { Scheduled: 0, Referred: 1, Completed: 2, Cancelled: 3 };

@Controller('counselling')
export class CounsellingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: SafetyContext,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  private async rows(list: SafetyCounsellingSession[], canNotes: boolean) {
    const [students, counsellors] = await Promise.all([this.ctx.students(list.map((s) => s.studentId)), this.ctx.employees(list.map((s) => s.counsellorId))]);
    return list.map((x) => {
      const s = students.get(x.studentId);
      return {
        id: x.id,
        sessionOn: x.sessionOn.toISOString(),
        reason: x.reason,
        status: x.status as 'Scheduled' | 'Completed' | 'Cancelled' | 'Referred',
        notes: canNotes ? x.notes : null,
        hasNotes: !!x.notes,
        counsellorId: x.counsellorId,
        counsellorName: counsellors.get(x.counsellorId)?.fullName ?? '—',
        studentId: x.studentId,
        studentName: s?.fullName ?? 'Unknown student',
        admissionNo: s?.admissionNo ?? '',
        grade: s?.grade ?? null,
        section: s?.section ?? null,
      };
    });
  }

  @Get('sessions')
  @RequirePermissions('safety.read', 'safety.manage')
  async list(@Query() q: SessionQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const p = pageOf(q);
    const canNotes = user.permissions.has(SENSITIVE);
    const recordWhere = await this.ctx.recordWhere(user, q.campusId);
    const now = new Date();
    const term = q.q?.trim();
    const where: Prisma.SafetyCounsellingSessionWhereInput = {
      ...recordWhere,
      ...(q.status ? { status: q.status } : {}),
      ...(q.when === 'upcoming' ? { sessionOn: { gte: now } } : q.when === 'past' ? { sessionOn: { lt: now } } : {}),
      ...(q.studentId ? { AND: [{ studentId: q.studentId }] } : {}),
    };
    if (term) {
      const ids = await this.ctx.matchingStudentIds(user, term, q.campusId);
      where.OR = [{ reason: { contains: term, mode: 'insensitive' } }, { studentId: { in: ids } }];
    }
    const list = await this.prisma.safetyCounsellingSession.findMany({ where, orderBy: { sessionOn: 'desc' }, take: 10_000 });
    const rows = await this.rows(list, canNotes);
    const sorted = sortRows(rows, q.sort, q.dir, {
      date: (r) => r.sessionOn,
      student: (r) => r.studentName,
      counsellor: (r) => r.counsellorName,
      status: (r) => STATUS_ORDER[r.status] ?? 9,
      reason: (r) => r.reason,
    }, 'date', 'desc');
    const page = sorted.slice(p.skip, p.skip + p.take);
    const withNotes = page.filter((r) => r.notes);
    if (withNotes.length) {
      await this.audit.record({
        user, action: 'view', module: 'safety', entityType: ENTITY, sensitive: true, req,
        description: `Viewed confidential counselling notes for ${withNotes.length} session${withNotes.length === 1 ? '' : 's'} (${[...new Set(withNotes.map((r) => r.studentName))].slice(0, 5).join(', ')})`,
        metadata: { sessionIds: withNotes.map((r) => r.id) },
      });
    }
    return paged(page, rows.length, p);
  }

  @Get('summary')
  @RequirePermissions('safety.read', 'safety.manage')
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const clock = await this.ctx.clock();
    const year = await this.ctx.academicYear(clock);
    const recordWhere = await this.ctx.recordWhere(user, q.campusId);
    const now = new Date();
    const inYear: Prisma.SafetyCounsellingSessionWhereInput = { ...recordWhere, sessionOn: { gte: year.start, lt: year.end } };
    const [yearSessions, scheduled] = await Promise.all([
      this.prisma.safetyCounsellingSession.findMany({ where: inYear, select: { studentId: true, status: true, reason: true } }),
      this.prisma.safetyCounsellingSession.findMany({ where: { ...recordWhere, status: 'Scheduled' }, select: { studentId: true, sessionOn: true } }),
    ]);
    const active = yearSessions.filter((s) => s.status !== 'Cancelled');
    const reasons = new Map<string, { label: string; value: number }>();
    for (const s of active) {
      const key = s.reason.trim().toLowerCase();
      const r = reasons.get(key);
      if (r) r.value++;
      else reasons.set(key, { label: s.reason.trim().charAt(0).toUpperCase() + s.reason.trim().slice(1), value: 1 });
    }
    const referredStudents = new Set(yearSessions.filter((s) => s.status === 'Referred').map((s) => s.studentId));
    return {
      studentsSupported: new Set(active.map((s) => s.studentId)).size,
      sessionsThisYear: yearSessions.filter((s) => s.status === 'Completed').length,
      openCases: new Set([...scheduled.map((s) => s.studentId), ...referredStudents]).size,
      upcoming: scheduled.filter((s) => s.sessionOn >= now).length,
      referrals: yearSessions.filter((s) => s.status === 'Referred').length,
      reasons: [...reasons.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)).slice(0, 6),
      canViewNotes: user.permissions.has(SENSITIVE),
    };
  }

  @Post('sessions')
  @RequirePermissions('safety.manage')
  async create(@Body() dto: CreateSessionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const canNotes = user.permissions.has(SENSITIVE);
    if (dto.notes?.trim() && !canNotes) throw forbidden('Only the counsellor or the Principal can record session notes');
    const sessionOn = new Date(dto.sessionOn);
    if (Number.isNaN(sessionOn.getTime())) throw fieldError('sessionOn', 'Choose a date and time');
    const student = await this.ctx.assertStudent(user, dto.studentId);
    const counsellor = await this.prisma.employee.findUnique({ where: { id: dto.counsellorId }, select: { id: true, fullName: true } });
    if (!counsellor) throw fieldError('counsellorId', 'Choose the counsellor');
    const status = dto.status ?? 'Scheduled';
    const now = new Date();
    const session = await this.prisma.safetyCounsellingSession.create({
      data: {
        campusId: student.campusId,
        studentId: student.id,
        counsellorId: counsellor.id,
        sessionOn,
        reason: dto.reason.trim(),
        status,
        notes: dto.notes?.trim() || null,
        notesUpdatedAt: dto.notes?.trim() ? now : null,
        notesUpdatedById: dto.notes?.trim() ? user.id : null,
        referredAt: status === 'Referred' ? now : null,
        createdById: user.id,
      },
    });
    const counsellorUsers = (await this.ctx.usersForEmployees([counsellor.id])).filter((id) => id !== user.id);
    if (counsellorUsers.length && status === 'Scheduled') {
      const clock = await this.ctx.clock();
      await this.notifications.notifyUsers(counsellorUsers, {
        category: 'Information',
        topic: 'safety',
        module: 'safety',
        title: `Counselling session booked: ${student.fullName}`,
        body: `${clock.date(sessionOn)} at ${clock.time(sessionOn)} · ${session.reason}`,
        route: '/counselling',
        campusId: student.campusId,
      });
    }
    if (status === 'Referred') await this.referral(session, student);
    await this.audit.record({
      user, action: 'create', module: 'safety', entityType: ENTITY, entityId: session.id, campusId: student.campusId, sensitive: true, req,
      description: `Booked a counselling session for ${student.fullName} with ${counsellor.fullName} (${status})${session.notes ? ', with notes' : ''}`,
    });
    const [row] = await this.rows([session], canNotes);
    return ok(row, status === 'Scheduled' ? 'Session booked' : 'Session recorded');
  }

  @Patch('sessions/:id')
  @RequirePermissions('safety.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSessionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const canNotes = user.permissions.has(SENSITIVE);
    const before = await this.prisma.safetyCounsellingSession.findUnique({ where: { id } });
    if (!before) throw notFound('Session');
    const student = await this.ctx.assertStudent(user, before.studentId);
    if (dto.notes !== undefined && !canNotes) throw forbidden('Only the counsellor or the Principal can record session notes');
    const data: Prisma.SafetyCounsellingSessionUpdateInput = {};
    const changes: string[] = [];
    const now = new Date();
    if (dto.status && dto.status !== before.status) {
      data.status = dto.status;
      if (dto.status === 'Referred') data.referredAt = now;
      changes.push(`status ${before.status} → ${dto.status}`);
    }
    if (dto.sessionOn) {
      const when = new Date(dto.sessionOn);
      if (Number.isNaN(when.getTime())) throw fieldError('sessionOn', 'Choose a date and time');
      if (when.getTime() !== before.sessionOn.getTime()) {
        data.sessionOn = when;
        changes.push('rescheduled');
      }
    }
    if (dto.notes !== undefined && (dto.notes.trim() || null) !== before.notes) {
      Object.assign(data, { notes: dto.notes.trim() || null, notesUpdatedAt: now, notesUpdatedById: user.id });
      changes.push('notes updated');
    }
    if (!changes.length) throw badRequest('Nothing to change');
    const session = await this.prisma.safetyCounsellingSession.update({ where: { id }, data });
    if (session.status === 'Referred' && before.status !== 'Referred') await this.referral(session, student);
    await this.audit.record({
      user, action: 'update', module: 'safety', entityType: ENTITY, entityId: id, campusId: student.campusId, sensitive: true, req,
      description: `Updated the counselling session of ${student.fullName}: ${changes.join(', ')}`,
    });
    const [row] = await this.rows([session], canNotes);
    return ok(row, session.status === 'Referred' && before.status !== 'Referred' ? 'Session saved — external referral recorded, Principal informed' : 'Session saved');
  }

  /** External referrals are always reported to the Principal / DSL. */
  private async referral(session: SafetyCounsellingSession, student: StudentInfo) {
    await this.notifications.notifyPermission(SENSITIVE, {
      category: 'Attention',
      topic: 'safety',
      module: 'safety',
      title: `External referral: ${student.fullName}`,
      body: `Counselling referral recorded (${session.reason}).`,
      route: '/counselling?status=Referred',
      campusId: student.campusId,
    });
  }
}
