import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Prisma, TimetablePeriod } from '@prisma/client';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AcademicsAccess } from './academics.access';
import { asDate, DAY_NAMES, nextDateForDay, schoolToday, shortDate, timetableDay } from './academics.util';
import { isLesson, TimetableService } from './timetable.service';

class TimetableQuery {
  @IsOptional() @IsString() sectionId?: string;
  @IsOptional() @IsString() campusId?: string;
}

class EntryDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID('all', { message: 'Choose a subject' }) subjectId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40, { message: 'Use 40 characters or fewer' }) activity?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID('all', { message: 'Choose a teacher' }) employeeId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40, { message: 'Use 40 characters or fewer' }) room?: string | null;
  @IsOptional() @IsBoolean() needsSubstitute?: boolean;
}

class SubstituteDto {
  @IsUUID('all', { message: 'Choose a teacher to cover this period' }) substituteId: string;
  @IsOptional() @IsString() @MaxLength(200, { message: 'Keep the note under 200 characters' }) note?: string;
}

class PublishDto {
  @IsUUID('all', { message: 'Choose a class' }) sectionId: string;
}

@Controller('academics/timetable')
export class TimetableController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly access: AcademicsAccess,
    private readonly tt: TimetableService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** A section's weekly timetable, or (without sectionId) the signed-in teacher's own. */
  @Get()
  @RequirePermissions('academics.read')
  async timetable(@Query() q: TimetableQuery, @CurrentUser() user: AuthUser) {
    await this.tt.expireCovers();
    const today = schoolToday();
    const manager = user.permissions.has('academics.manage') && this.access.isSchoolLevel(user);
    let title: string;
    let campusId: string;
    let entries;
    if (q.sectionId) {
      const s = await this.access.assertSection(user, q.sectionId);
      title = s.label;
      campusId = s.campusId;
      const periods = await this.tt.periods(campusId);
      if (manager) await this.tt.ensureSlots(s.id, campusId, periods);
      entries = await this.prisma.timetableEntry.findMany({ where: { sectionId: s.id }, orderBy: [{ day: 'asc' }, { periodNo: 'asc' }] });
      // Blank slots are only shown to the academic office, who fill them in.
      if (!manager) entries = entries.filter(isLesson);
    } else {
      if (!user.employeeId) throw badRequest('Your account is not linked to a staff record. Choose a class to see its timetable.');
      const emp = await this.prisma.employee.findUnique({ where: { id: user.employeeId } });
      if (!emp) throw notFound('Staff record');
      title = emp.fullName;
      campusId = emp.campusId;
      entries = (
        await this.prisma.timetableEntry.findMany({
          where: { OR: [{ employeeId: emp.id }, { substituteId: emp.id }] },
          orderBy: [{ day: 'asc' }, { periodNo: 'asc' }],
        })
      ).filter(isLesson);
    }
    const periodsByCampus = await this.periodsFor([campusId, ...entries.map((e) => e.campusId)]);
    const dtos = await this.tt.toDtos(entries, periodsByCampus);
    const conflicts = dtos
      .filter((e) => e.needsSubstitute && !e.substituteId && isLesson(e))
      .sort((a, b) => a.date.localeCompare(b.date) || a.periodNo - b.periodNo);
    const periods = periodsByCampus.get(campusId) ?? [];
    return {
      title,
      campusId,
      days: DAY_NAMES,
      periods: periods.map((p) => ({ id: p.id, periodNo: p.periodNo, startsAt: p.startsAt, endsAt: p.endsAt })),
      entries: dtos.map(({ teacherStatus, date, ...e }) => e),
      conflicts,
      today: { date: today, day: timetableDay(today) },
    };
  }

  /** Teacher load against the agreed maximum, and how full the timetables are. */
  @Get('insights')
  @RequirePermissions('academics.read')
  async insights(@Query() q: TimetableQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.access.restricted(user) ? user.campusId ?? undefined : this.scope.campus(user, q.campusId);
    const where: Prisma.TimetableEntryWhereInput = campusId ? { campusId } : {};
    const entries = (await this.prisma.timetableEntry.findMany({ where, select: { sectionId: true, campusId: true, employeeId: true, subjectId: true, activity: true } })).filter(isLesson);
    const load = new Map<string, number>();
    for (const e of entries) if (e.employeeId) load.set(e.employeeId, (load.get(e.employeeId) ?? 0) + 1);
    const staff = await this.prisma.employee.findMany({ where: { id: { in: [...load.keys()] } }, select: { id: true, fullName: true, maxPeriodsWeek: true } });
    const teacherLoad = staff
      .map((s) => ({ id: s.id, name: s.fullName, periods: load.get(s.id) ?? 0, maxPeriods: s.maxPeriodsWeek }))
      .sort((a, b) => b.periods - a.periods || a.name.localeCompare(b.name))
      .slice(0, 12);
    // The agreed load is the most common maximum across the listed teachers.
    const freq = new Map<number, number>();
    for (const s of staff) freq.set(s.maxPeriodsWeek, (freq.get(s.maxPeriodsWeek) ?? 0) + 1);
    const agreedLoad = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 27;

    const sections = new Map<string, string>();
    for (const e of entries) sections.set(e.sectionId, e.campusId);
    const periodCounts = await this.prisma.timetablePeriod.groupBy({ by: ['campusId'], where: { campusId: { in: [...new Set(sections.values())] } }, _count: { _all: true } });
    const perCampus = new Map(periodCounts.map((p) => [p.campusId, p._count._all]));
    const slots = [...sections.values()].reduce((n, c) => n + (perCampus.get(c) ?? 0) * DAY_NAMES.length, 0);
    const filled = entries.length;
    return { teacherLoad, agreedLoad, utilisation: { filled, slots, pct: slots ? Math.round((100 * filled) / slots) : 0 } };
  }

  /** Free teachers who could cover a period, best match first. */
  @Get('entries/:id/substitutes')
  @RequirePermissions('academics.read')
  async substitutes(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const e = await this.entry(id, user);
    const today = schoolToday();
    const date = e.coverDate ? e.coverDate.toISOString().slice(0, 10) : nextDateForDay(today, e.day);
    const [section, subjects] = await Promise.all([this.access.sectionInfo([e.sectionId]), this.access.subjectNames([e.subjectId])]);
    const away = await this.tt.unavailable([e.employeeId ?? ''], date);
    const teacherStatus = e.employeeId ? away.get(e.employeeId) ?? (e.needsSubstitute ? 'Unavailable' : null) : null;
    const subject = e.subjectId ? subjects.get(e.subjectId) ?? null : null;
    const suggestions = await this.candidates(e, date, subject);
    return {
      entry: {
        id: e.id,
        day: DAY_NAMES[e.day - 1] ?? '',
        date,
        periodNo: e.periodNo,
        section: section.get(e.sectionId)?.label ?? '',
        subject: subject ?? e.activity,
        room: e.room,
        teacherStatus,
      },
      suggestions,
    };
  }

  @Post('entries/:id/substitute')
  @HttpCode(200)
  @RequirePermissions('academics.manage')
  async assign(@Param('id') id: string, @Body() dto: SubstituteDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.entry(id, user);
    if (!isLesson(e)) throw badRequest('This period has no lesson to cover');
    const date = nextDateForDay(schoolToday(), e.day);
    const subject = e.subjectId ? (await this.access.subjectNames([e.subjectId])).get(e.subjectId) ?? null : null;
    const ok_ = (await this.candidates(e, date, subject, 1000)).some((c) => c.id === dto.substituteId);
    if (!ok_) throw fieldError('substituteId', 'This teacher is not free to cover this period');
    await this.prisma.timetableEntry.update({
      where: { id },
      data: { substituteId: dto.substituteId, substituteNote: dto.note?.trim() || null, coverDate: asDate(date), coverAssignedById: user.id, needsSubstitute: true },
    });
    const [sections, staff, users] = await Promise.all([
      this.access.sectionInfo([e.sectionId]),
      this.access.employeeNames([dto.substituteId, e.employeeId]),
      this.access.usersForEmployees([dto.substituteId]),
    ]);
    const label = sections.get(e.sectionId)?.label ?? 'class';
    const what = `${DAY_NAMES[e.day - 1]} Period ${e.periodNo} · ${label} ${subject ?? e.activity ?? ''}`.trim();
    const subName = staff.get(dto.substituteId) ?? 'The substitute';
    const userId = users.get(dto.substituteId);
    if (userId) {
      await this.notifications.notifyUsers([userId], {
        category: 'Attention', topic: 'system', module: 'academics', campusId: e.campusId, deliver: true,
        title: `Cover lesson on ${shortDate(date)}: ${what}`,
        body: [e.room ? `Room ${e.room}` : null, dto.note?.trim() ? `Note: ${dto.note.trim()}` : null].filter(Boolean).join(' · ') || undefined,
        route: '/timetable?view=mine',
      });
    }
    await this.audit.record({ user, action: 'update', module: 'academics', entityType: 'timetable_entry', entityId: id, campusId: e.campusId, description: `Assigned ${subName} to cover ${what} on ${date}`, req });
    return ok({ id, substituteId: dto.substituteId, date }, `${subName} assigned as cover${userId ? ' and notified' : ''}`);
  }

  @Delete('entries/:id/substitute')
  @RequirePermissions('academics.manage')
  async unassign(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.entry(id, user);
    if (!e.substituteId) throw badRequest('No cover is arranged for this period');
    await this.prisma.timetableEntry.update({ where: { id }, data: { substituteId: null, substituteNote: null, coverDate: null, coverAssignedById: null, needsSubstitute: true } });
    const [staff, users, sections] = await Promise.all([
      this.access.employeeNames([e.substituteId]),
      this.access.usersForEmployees([e.substituteId]),
      this.access.sectionInfo([e.sectionId]),
    ]);
    const label = `${DAY_NAMES[e.day - 1]} Period ${e.periodNo} · ${sections.get(e.sectionId)?.label ?? ''}`;
    const userId = users.get(e.substituteId);
    if (userId) {
      await this.notifications.notifyUsers([userId], { category: 'Information', topic: 'system', module: 'academics', campusId: e.campusId, title: `Cover cancelled: ${label}`, route: '/timetable?view=mine' });
    }
    await this.audit.record({ user, action: 'update', module: 'academics', entityType: 'timetable_entry', entityId: id, campusId: e.campusId, description: `Removed ${staff.get(e.substituteId) ?? 'substitute'} as cover for ${label}`, req });
    return ok(null, 'Cover removed — the period needs a substitute again');
  }

  /** Edits one period (academic office). */
  @Put('entries/:id')
  @RequirePermissions('academics.manage')
  async update(@Param('id') id: string, @Body() dto: EntryDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!this.access.isSchoolLevel(user)) throw forbidden('Only the academic office can change the timetable');
    const e = await this.entry(id, user);
    const subjectId = dto.subjectId !== undefined ? dto.subjectId : e.subjectId;
    const activity = subjectId ? null : dto.activity !== undefined ? dto.activity?.trim() || null : e.activity;
    if (!subjectId && !activity) throw fieldError('activity', 'Choose a subject or enter an activity');
    if (subjectId && !(await this.prisma.subject.findUnique({ where: { id: subjectId } }))) throw fieldError('subjectId', 'Choose a subject');
    const employeeId = dto.employeeId !== undefined ? dto.employeeId : e.employeeId;
    if (employeeId) {
      const t = await this.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!t || t.archivedAt || t.employmentStatus === 'exited') throw fieldError('employeeId', 'Choose a current member of staff');
      if (t.employeeType !== 'teaching') throw fieldError('employeeId', 'Choose a teacher');
      if (t.campusId !== e.campusId) throw fieldError('employeeId', 'Choose a teacher at the same campus');
      const clash = await this.prisma.timetableEntry.findFirst({ where: { employeeId, day: e.day, periodNo: e.periodNo, NOT: { id } } });
      if (clash) {
        const s = (await this.access.sectionInfo([clash.sectionId])).get(clash.sectionId);
        throw fieldError('employeeId', `${t.fullName} already teaches ${s?.label ?? 'another class'} in ${DAY_NAMES[e.day - 1]} Period ${e.periodNo}`);
      }
    }
    const teacherChanged = employeeId !== e.employeeId;
    const updated = await this.prisma.timetableEntry.update({
      where: { id },
      data: {
        subjectId: subjectId ?? null,
        activity,
        employeeId: employeeId ?? null,
        room: dto.room !== undefined ? dto.room?.trim() || null : e.room,
        needsSubstitute: dto.needsSubstitute ?? e.needsSubstitute,
        ...(teacherChanged || dto.needsSubstitute === false ? { substituteId: null, substituteNote: null, coverDate: null, coverAssignedById: null } : {}),
      },
    });
    const [sections, subjects, staff] = await Promise.all([
      this.access.sectionInfo([e.sectionId]),
      this.access.subjectNames([updated.subjectId]),
      this.access.employeeNames([updated.employeeId]),
    ]);
    const what = updated.subjectId ? subjects.get(updated.subjectId) : updated.activity;
    await this.audit.record({
      user, action: 'update', module: 'academics', entityType: 'timetable_entry', entityId: id, campusId: e.campusId, req,
      description: `Set ${sections.get(e.sectionId)?.label ?? ''} ${DAY_NAMES[e.day - 1]} Period ${e.periodNo} to ${what}${updated.employeeId ? ` with ${staff.get(updated.employeeId)}` : ''}${updated.needsSubstitute ? ' (needs a substitute)' : ''}`,
    });
    return ok({ id }, 'Timetable updated');
  }

  /** Tells every teacher on a section's timetable to check their periods. */
  @Post('publish')
  @HttpCode(200)
  @RequirePermissions('academics.manage')
  async publish(@Body() dto: PublishDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!this.access.isSchoolLevel(user)) throw forbidden('Only the academic office can publish timetable changes');
    const s = await this.access.assertSection(user, dto.sectionId);
    const entries = (await this.prisma.timetableEntry.findMany({ where: { sectionId: s.id } })).filter(isLesson);
    const users = await this.access.usersForEmployees(entries.flatMap((e) => [e.employeeId, e.substituteId]));
    const ids = [...new Set(users.values())];
    await this.notifications.notifyUsers(ids, {
      category: 'Information', topic: 'system', module: 'academics', campusId: s.campusId,
      title: `Timetable updated: ${s.label}`, body: 'The academic office published changes to this timetable. Check your periods for the week.',
      route: '/timetable?view=mine',
    });
    await this.audit.record({ user, action: 'publish', module: 'academics', entityType: 'timetable', entityId: s.id, campusId: s.campusId, description: `Published timetable changes for ${s.label} (${ids.length} teachers notified)`, req });
    return ok({ notified: ids.length }, `Timetable changes published — ${ids.length} teacher${ids.length === 1 ? '' : 's'} notified`);
  }

  // ---------------------------------------------------------------------------

  private async entry(id: string, user: AuthUser) {
    const e = await this.prisma.timetableEntry.findUnique({ where: { id } });
    if (!e) throw notFound('Timetable period');
    if (!(await this.access.canSeeSection(user, e.sectionId, e.campusId))) throw forbidden('This class is outside your access');
    return e;
  }

  private async periodsFor(campusIds: string[]): Promise<Map<string, TimetablePeriod[]>> {
    const out = new Map<string, TimetablePeriod[]>();
    for (const c of [...new Set(campusIds)]) out.set(c, await this.tt.periods(c));
    return out;
  }

  /** Teaching staff at the campus who are free in that period and present on the date. */
  private async candidates(e: { id: string; campusId: string; sectionId: string; day: number; periodNo: number; employeeId: string | null; subjectId: string | null }, date: string, subject: string | null, limit = 5) {
    const staff = await this.prisma.employee.findMany({
      where: { campusId: e.campusId, employeeType: 'teaching', archivedAt: null, employmentStatus: { not: 'exited' }, ...(e.employeeId ? { NOT: { id: e.employeeId } } : {}) },
      select: { id: true, fullName: true, maxPeriodsWeek: true },
    });
    if (!staff.length) return [];
    const ids = staff.map((s) => s.id);
    const [busy, all, away, accounts] = await Promise.all([
      this.prisma.timetableEntry.findMany({
        where: { day: e.day, periodNo: e.periodNo, OR: [{ employeeId: { in: ids } }, { substituteId: { in: ids }, coverDate: asDate(date) }] },
        select: { employeeId: true, substituteId: true, subjectId: true, activity: true },
      }),
      this.prisma.timetableEntry.findMany({ where: { employeeId: { in: ids } }, select: { employeeId: true, subjectId: true, sectionId: true, activity: true } }),
      this.tt.unavailable(ids, date),
      this.access.usersForEmployees(ids),
    ]);
    const busyIds = new Set<string>();
    for (const b of busy) {
      if (b.employeeId && isLesson(b)) busyIds.add(b.employeeId);
      if (b.substituteId) busyIds.add(b.substituteId);
    }
    const rank = { success: 0, info: 1, neutral: 2 } as const;
    return staff
      .filter((s) => !busyIds.has(s.id) && !away.has(s.id))
      .map((s) => {
        const mine = all.filter((x) => x.employeeId === s.id && isLesson(x));
        const sameSubject = !!e.subjectId && mine.some((x) => x.subjectId === e.subjectId);
        const sameClass = mine.some((x) => x.sectionId === e.sectionId);
        const match: keyof typeof rank = sameSubject ? 'success' : sameClass ? 'info' : 'neutral';
        const reason = [
          sameSubject ? `Teaches ${subject}` : sameClass ? 'Already teaches this class' : 'Free this period',
          `${mine.length} of ${s.maxPeriodsWeek} periods this week`,
        ].join(' · ');
        return { id: s.id, name: s.fullName, reason, match, hasAccount: accounts.has(s.id), load: mine.length, over: mine.length >= s.maxPeriodsWeek };
      })
      .sort((a, b) => Number(a.over) - Number(b.over) || rank[a.match] - rank[b.match] || a.load - b.load || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map(({ load, over, ...x }) => x);
  }
}
