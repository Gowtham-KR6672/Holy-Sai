import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { Employee } from '@prisma/client';
import { IsDateString, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { badRequest, fieldError, notFound } from '../../common/errors';
import { AuditService } from '../audit/audit.service';
import { WorkforceService } from './workforce.service';
import { addDays, dateLabel, dateOf, keyOf, minutes, mondayOf, splitPost, todayKey } from './workforce.util';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayName = (key: string) => DAY_NAMES[dateOf(key).getUTCDay()];

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class RosterQuery extends CampusQuery {
  @IsOptional() @Matches(DATE, { message: 'Use YYYY-MM-DD' }) weekStart?: string;
}

class ShiftDto {
  @IsString() @MinLength(2, { message: 'Name the shift' }) @MaxLength(60) name: string;
  @Matches(TIME, { message: 'Use HH:MM' }) startsAt: string;
  @Matches(TIME, { message: 'Use HH:MM' }) endsAt: string;
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @Matches(TIME, { message: 'Use HH:MM' }) splitStartsAt?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @Matches(TIME, { message: 'Use HH:MM' }) splitEndsAt?: string | null;
}

class RosterDto {
  @IsUUID('all', { message: 'Choose an employee' }) employeeId: string;
  @IsUUID('all', { message: 'Choose a shift' }) shiftId: string;
  @IsDateString({}, { message: 'Choose a date' }) date: string;
  @IsString() @MinLength(1, { message: 'Name the post' }) @MaxLength(170) post: string;
}

class PublishDto {
  @Matches(DATE, { message: 'Choose the week' }) weekStart: string;
  @IsOptional() @IsString() campusId?: string;
}

class FlagDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

class AssignDto {
  @IsUUID('all', { message: 'Choose who will cover' }) coverEmployeeId: string;
}

/** Shift patterns and weekly rosters: posts by day, publishing, and cover for gaps. */
@Controller('workforce')
export class RosterController {
  constructor(
    private readonly wf: WorkforceService,
    private readonly audit: AuditService,
  ) {}

  private get prisma() {
    return this.wf.prisma;
  }

  // ---------------------------------------------------------------------------
  // Shifts
  // ---------------------------------------------------------------------------

  @Get('shifts')
  @RequirePermissions('hr.read', 'hr.manage')
  async shifts(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.wf.campus(user, q.campusId);
    const [shifts, emps, today] = await Promise.all([
      this.prisma.workforceShift.findMany({ where: { isActive: true }, orderBy: [{ startsAt: 'asc' }, { name: 'asc' }] }),
      this.prisma.employee.groupBy({ by: ['shiftName'], where: this.wf.employeeWhere(campusId, { shiftName: { not: null } }), _count: true }),
      this.prisma.workforceRosterEntry.groupBy({ by: ['shiftId'], where: { date: dateOf(todayKey()), ...(campusId ? { campusId } : {}) }, _count: true }),
    ]);
    const empCount = new Map(emps.map((e) => [e.shiftName, e._count]));
    const todayCount = new Map(today.map((t) => [t.shiftId, t._count]));
    return shifts.map((s) => ({
      id: s.id,
      name: s.name,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      splitStartsAt: s.splitStartsAt,
      splitEndsAt: s.splitEndsAt,
      employees: empCount.get(s.name) ?? 0,
      rosteredToday: todayCount.get(s.id) ?? 0,
    }));
  }

  @Post('shifts')
  @RequirePermissions('hr.manage')
  async createShift(@Body() dto: ShiftDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const data = await this.shiftData(dto, null);
    const s = await this.prisma.workforceShift.create({ data });
    await this.audit.record({ user, action: 'create', module: 'workforce', entityType: 'shift', entityId: s.id, description: `Created shift ${s.name}`, req });
    return ok({ id: s.id }, 'Shift created');
  }

  @Put('shifts/:id')
  @RequirePermissions('hr.manage')
  async updateShift(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ShiftDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const existing = await this.prisma.workforceShift.findUnique({ where: { id } });
    if (!existing) throw notFound('Shift');
    const data = await this.shiftData(dto, id);
    await this.prisma.workforceShift.update({ where: { id }, data });
    let moved = 0;
    if (data.name !== existing.name) {
      // Employee records refer to their default shift by name.
      const r = await this.prisma.employee.updateMany({ where: { shiftName: existing.name }, data: { shiftName: data.name } });
      moved = r.count;
    }
    await this.audit.record({
      user, action: 'update', module: 'workforce', entityType: 'shift', entityId: id,
      description: `Updated shift ${existing.name}${data.name !== existing.name ? ` → ${data.name} (${moved} employee record${moved === 1 ? '' : 's'} updated)` : ''}`, req,
    });
    return ok({ id }, 'Shift updated');
  }

  private async shiftData(dto: ShiftDto, id: string | null) {
    const name = dto.name.trim();
    const clash = await this.prisma.workforceShift.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...(id ? { NOT: { id } } : {}) } });
    if (clash) throw fieldError('name', 'A shift with this name already exists');
    const splitStartsAt = dto.splitStartsAt || null;
    const splitEndsAt = dto.splitEndsAt || null;
    if (!!splitStartsAt !== !!splitEndsAt) throw fieldError('splitEndsAt', 'Give both split times or neither');
    if (dto.startsAt === dto.endsAt) throw fieldError('endsAt', 'The shift must end at a different time');
    if (splitStartsAt && splitEndsAt && (minutes(splitEndsAt) ?? 0) <= (minutes(splitStartsAt) ?? 0)) throw fieldError('splitEndsAt', 'The split must end after it starts');
    return { name, startsAt: dto.startsAt, endsAt: dto.endsAt, splitStartsAt, splitEndsAt };
  }

  // ---------------------------------------------------------------------------
  // Roster
  // ---------------------------------------------------------------------------

  @Get('roster')
  @RequirePermissions('hr.read')
  async roster(@Query() q: RosterQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.wf.campus(user, q.campusId);
    const today = todayKey();
    const weekStart = mondayOf(q.weekStart ?? today);
    const days = Array.from({ length: 6 }, (_, i) => addDays(weekStart, i));
    const [entries, recent] = await Promise.all([
      this.prisma.workforceRosterEntry.findMany({
        where: { date: { gte: dateOf(days[0]), lte: dateOf(days[5]) }, ...(campusId ? { campusId } : {}) },
        include: { shift: true },
        orderBy: [{ date: 'asc' }, { post: 'asc' }],
      }),
      this.prisma.workforceRosterEntry.findMany({
        where: { date: { gte: dateOf(addDays(weekStart, -28)), lte: dateOf(days[5]) }, ...(campusId ? { campusId } : {}) },
        distinct: ['post'],
        select: { post: true },
      }),
    ]);
    const people = await this.wf.employeesByIds([...entries.map((e) => e.employeeId), ...entries.map((e) => e.coverEmployeeId)]);
    const attendance = await this.attendanceFor(entries.map((e) => ({ employeeId: e.employeeId, date: keyOf(e.date) })));
    const rows = entries.map((e) => {
      const date = keyOf(e.date);
      const emp = people.get(e.employeeId);
      const { group, duty } = splitPost(e.post);
      const att = attendance.get(`${e.employeeId}|${date}`) ?? null;
      const completed = e.status === 'Scheduled' && date < today && !!att && ['Present', 'Late', 'Half Day'].includes(att);
      return {
        id: e.id,
        employeeId: e.employeeId,
        employeeName: emp?.fullName ?? 'Former employee',
        designation: emp?.designation ?? '',
        employeeType: emp?.employeeType ?? 'non_teaching',
        date,
        group,
        duty,
        post: e.post,
        shiftId: e.shiftId,
        shiftName: e.shift.name,
        status: completed ? 'Completed' : e.status,
        attendance: att,
        coveredById: e.coverEmployeeId,
        coveredByName: e.coverEmployeeId ? people.get(e.coverEmployeeId)?.fullName ?? null : null,
        published: !!e.publishedAt,
      };
    });
    const groups = [...new Set([...recent.map((r) => splitPost(r.post).group), ...rows.map((r) => r.group)])].sort((a, b) => a.localeCompare(b));
    return {
      weekStart,
      today,
      days,
      groups,
      entries: rows,
      gaps: rows.filter((r) => r.status === 'Cover needed'),
      attention: rows.filter((r) => r.status === 'Scheduled' && (r.attendance === 'Absent' || r.attendance === 'On Leave')),
      published: rows.length > 0 && rows.every((r) => r.published),
    };
  }

  /** Attendance for (employee, date) pairs: the mark (past/today) or approved leave (any day). Not marked → null. */
  private async attendanceFor(pairs: { employeeId: string; date: string }[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!pairs.length) return out;
    const ids = [...new Set(pairs.map((p) => p.employeeId))];
    const dates = pairs.map((p) => p.date).sort();
    const from = dateOf(dates[0]);
    const to = dateOf(dates[dates.length - 1]);
    const [marks, leave] = await Promise.all([
      this.prisma.workforceAttendance.findMany({ where: { employeeId: { in: ids }, date: { gte: from, lte: to } }, select: { employeeId: true, date: true, status: true } }),
      this.prisma.workforceLeaveRequest.findMany({
        where: { employeeId: { in: ids }, status: 'Approved', halfDay: false, fromDate: { lte: to }, toDate: { gte: from } },
        select: { employeeId: true, fromDate: true, toDate: true },
      }),
    ]);
    for (const m of marks) out.set(`${m.employeeId}|${keyOf(m.date)}`, m.status);
    for (const p of pairs) {
      const k = `${p.employeeId}|${p.date}`;
      if (out.has(k)) continue;
      if (leave.some((l) => l.employeeId === p.employeeId && keyOf(l.fromDate) <= p.date && keyOf(l.toDate) >= p.date)) out.set(k, 'On Leave');
    }
    return out;
  }

  /** Puts a person on a post for a day; replaces any existing line for that person on that day. */
  @Post('roster')
  @RequirePermissions('hr.manage')
  async addEntry(@Body() dto: RosterDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const date = dto.date.slice(0, 10);
    if (date < todayKey()) throw fieldError('date', 'Choose today or a later date');
    const emp = await this.activeEmployee(dto.employeeId, user, 'employeeId');
    const shift = await this.prisma.workforceShift.findUnique({ where: { id: dto.shiftId } });
    if (!shift || !shift.isActive) throw fieldError('shiftId', 'Choose a shift');
    const unavailable = await this.unavailability(emp.id, date);
    if (unavailable === 'On Leave') throw fieldError('employeeId', `${emp.fullName} is on approved leave on ${dateLabel(date)}`);
    const post = dto.post.trim().replace(/\s+/g, ' ');
    const data = {
      campusId: emp.campusId, shiftId: shift.id, post, status: 'Scheduled', coverEmployeeId: null, coverReason: null, coverFlaggedAt: null, publishedAt: null,
      createdById: user.id,
    };
    const existing = await this.prisma.workforceRosterEntry.findUnique({ where: { employeeId_date: { employeeId: emp.id, date: dateOf(date) } } });
    const row = await this.prisma.workforceRosterEntry.upsert({
      where: { employeeId_date: { employeeId: emp.id, date: dateOf(date) } },
      create: { employeeId: emp.id, date: dateOf(date), ...data },
      update: data,
    });
    await this.audit.record({
      user, action: existing ? 'update' : 'create', module: 'workforce', entityType: 'roster_entry', entityId: row.id, campusId: emp.campusId,
      description: `Rostered ${emp.fullName} on ${post} (${shift.name}) for ${date}${existing ? ` — replaced ${existing.post}` : ''}`, req,
    });
    return ok({ id: row.id }, 'Added to the roster');
  }

  @Post('roster/publish')
  @HttpCode(200)
  @RequirePermissions('hr.manage')
  async publish(@Body() dto: PublishDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const campusId = this.wf.campus(user, dto.campusId);
    const week = mondayOf(dto.weekStart);
    const where = { date: { gte: dateOf(week), lte: dateOf(addDays(week, 5)) }, ...(campusId ? { campusId } : {}) };
    const entries = await this.prisma.workforceRosterEntry.findMany({ where, select: { employeeId: true, coverEmployeeId: true } });
    if (!entries.length) throw badRequest('Nothing is rostered for this week');
    await this.prisma.workforceRosterEntry.updateMany({ where, data: { publishedAt: new Date() } });
    const people = [...new Set([...entries.map((e) => e.employeeId), ...entries.map((e) => e.coverEmployeeId).filter((x): x is string => !!x)])];
    await this.wf.notifyEmployees(people, {
      category: 'Information', topic: 'system', module: 'workforce', campusId: campusId ?? null,
      title: `Roster published — week of ${dateLabel(week)}`,
      body: 'Your shifts and posts for the week are in staff self-service.', route: '/staff-self', deliver: true,
    });
    await this.audit.record({
      user, action: 'publish', module: 'workforce', entityType: 'roster', entityId: week, campusId: campusId ?? null,
      description: `Published the roster for the week of ${week} (${entries.length} line${entries.length === 1 ? '' : 's'}, ${people.length} colleague${people.length === 1 ? '' : 's'})`, req,
    });
    return ok({ weekStart: week, lines: entries.length, notified: people.length }, `Roster published — ${people.length} colleague${people.length === 1 ? '' : 's'} notified`);
  }

  @Delete('roster/:id')
  @RequirePermissions('hr.manage')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.entry(id, user);
    if (keyOf(e.date) < todayKey()) throw badRequest('Past roster lines are kept as a record');
    await this.prisma.workforceRosterEntry.delete({ where: { id } });
    const emp = await this.prisma.employee.findUnique({ where: { id: e.employeeId }, select: { fullName: true } });
    await this.audit.record({
      user, action: 'delete', module: 'workforce', entityType: 'roster_entry', entityId: id, campusId: e.campusId,
      description: `Removed ${emp?.fullName ?? 'employee'} from ${e.post} on ${keyOf(e.date)}`, req,
    });
    return ok({ id }, 'Roster line removed');
  }

  @Post('roster/:id/flag-cover')
  @HttpCode(200)
  @RequirePermissions('hr.manage')
  async flagCover(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FlagDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.entry(id, user);
    const date = keyOf(e.date);
    if (date < todayKey()) throw badRequest('This day has passed');
    const { group } = splitPost(e.post);
    if (e.status === 'Cover needed') return ok({ id }, `${group} is already flagged for cover`);
    const emp = await this.prisma.employee.findUnique({ where: { id: e.employeeId }, select: { fullName: true } });
    const reason = dto.reason?.trim() || 'Cover requested';
    await this.prisma.workforceRosterEntry.update({ where: { id }, data: { status: 'Cover needed', coverEmployeeId: null, coverReason: reason, coverFlaggedAt: new Date() } });
    await this.wf.notifications.notifyPermission('hr.manage', {
      category: 'Attention', topic: 'system', module: 'workforce', campusId: e.campusId,
      title: `Cover needed: ${group} on ${dayName(date)} ${dateLabel(date)}`,
      body: `${emp?.fullName ?? 'The rostered colleague'} — ${reason}. Assign a colleague in Shifts & Rosters.`, route: '/shifts',
    });
    await this.audit.record({
      user, action: 'update', module: 'workforce', entityType: 'roster_entry', entityId: id, campusId: e.campusId,
      description: `Flagged cover needed for ${e.post} on ${date} (${emp?.fullName ?? ''}): ${reason}`, req,
    });
    return ok({ id }, `Cover flagged for ${group} — HR has been notified`);
  }

  @Post('roster/:id/assign-cover')
  @HttpCode(200)
  @RequirePermissions('hr.manage')
  async assignCover(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.entry(id, user);
    const date = keyOf(e.date);
    if (date < todayKey()) throw badRequest('This day has passed');
    if (dto.coverEmployeeId === e.employeeId) throw fieldError('coverEmployeeId', 'Choose a different colleague');
    const cover = await this.activeEmployee(dto.coverEmployeeId, user, 'coverEmployeeId');
    const away = await this.unavailability(cover.id, date);
    if (away) throw fieldError('coverEmployeeId', `${cover.fullName} is ${away === 'On Leave' ? 'on leave' : 'absent'} that day`);
    await this.prisma.workforceRosterEntry.update({ where: { id }, data: { status: 'Covered', coverEmployeeId: cover.id } });
    const { group } = splitPost(e.post);
    const emp = await this.prisma.employee.findUnique({ where: { id: e.employeeId }, select: { fullName: true } });
    await this.wf.notifyEmployees([cover.id], {
      category: 'Attention', topic: 'system', module: 'workforce', campusId: e.campusId,
      title: `You are covering ${group} on ${dayName(date)} ${dateLabel(date)}`,
      body: `${e.post} for ${emp?.fullName ?? 'a colleague'}.`, route: '/staff-self', deliver: true,
    });
    await this.audit.record({
      user, action: 'update', module: 'workforce', entityType: 'roster_entry', entityId: id, campusId: e.campusId,
      description: `Assigned ${cover.fullName} to cover ${e.post} on ${date} for ${emp?.fullName ?? ''}`, req,
    });
    return ok({ id }, `${cover.fullName} is covering ${group}`);
  }

  // ---------------------------------------------------------------------------

  private async entry(id: string, user: AuthUser) {
    const e = await this.prisma.workforceRosterEntry.findUnique({ where: { id } });
    if (!e) throw notFound('Roster line');
    const campusId = this.wf.campus(user, null);
    if (campusId && e.campusId !== campusId && !user.permissions.has('dashboard.group')) throw notFound('Roster line');
    return e;
  }

  private async activeEmployee(id: string, user: AuthUser, field: string): Promise<Employee> {
    const emp = await this.prisma.employee.findUnique({ where: { id } });
    if (!emp || emp.archivedAt || emp.employmentStatus === 'exited') throw fieldError(field, 'Choose an active employee');
    const campusId = this.wf.campus(user, null);
    if (campusId && emp.campusId !== campusId && !user.permissions.has('dashboard.group')) throw fieldError(field, 'This employee is on another campus');
    return emp;
  }

  /** "Absent" or "On Leave" when the person cannot work that day, else null. */
  private async unavailability(employeeId: string, date: string): Promise<'Absent' | 'On Leave' | null> {
    const [mark, leave] = await Promise.all([
      this.prisma.workforceAttendance.findUnique({ where: { employeeId_date: { employeeId, date: dateOf(date) } }, select: { status: true } }),
      this.prisma.workforceLeaveRequest.count({ where: { employeeId, status: 'Approved', halfDay: false, fromDate: { lte: dateOf(date) }, toDate: { gte: dateOf(date) } } }),
    ]);
    if (mark?.status === 'Absent') return 'Absent';
    if (mark?.status === 'On Leave' || leave) return 'On Leave';
    return null;
  }
}
