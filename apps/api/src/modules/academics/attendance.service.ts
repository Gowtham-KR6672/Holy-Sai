import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { badRequest, forbidden } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { AcademicsAccess, type SectionInfo } from './academics.access';
import { AcademicsExtensions } from './academics.extensions';
import {
  addDays, asDate, dayKey, iso, pct, recentSchoolDays, round1, schoolNow, schoolToday, shortDate, timetableDay, weekdayOf,
} from './academics.util';
import { isLesson } from './timetable.service';

export type AttStatus = 'present' | 'late' | 'absent' | 'leave';
export const ATT_STATUSES: AttStatus[] = ['present', 'late', 'absent', 'leave'];

/** Teachers may correct registers up to this many days back; older registers belong to the school office. */
const TEACHER_EDIT_DAYS = 7;

export interface SectionDayStatus {
  students: number;
  marked: number;
  /** Marked | Pending | Not marked */
  status: string;
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly access: AcademicsAccess,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  /** Register state per section for a date. */
  async sectionStatus(sectionIds: string[], date: string): Promise<Map<string, SectionDayStatus>> {
    const out = new Map<string, SectionDayStatus>();
    if (!sectionIds.length) return out;
    const [counts, marks] = await Promise.all([
      this.access.studentCounts(sectionIds),
      this.prisma.studentAttendance.groupBy({ by: ['sectionId'], where: { sectionId: { in: sectionIds }, date: asDate(date) }, _count: { _all: true } }),
    ]);
    for (const id of sectionIds) {
      const students = counts.get(id) ?? 0;
      const marked = marks.find((m) => m.sectionId === id)?._count._all ?? 0;
      out.set(id, { students, marked, status: students > 0 && marked >= students ? 'Marked' : marked > 0 ? 'Pending' : 'Not marked' });
    }
    return out;
  }

  /** Sections with students the user may mark or view, with the register state for the date. */
  async sections(user: AuthUser, campusId: string | undefined, date: string) {
    const all = await this.access.sections(user, campusId);
    const status = await this.sectionStatus(all.map((s) => s.id), date);
    return all
      .filter((s) => (status.get(s.id)?.students ?? 0) > 0)
      .map((s) => {
        const st = status.get(s.id)!;
        return { id: s.id, label: s.label, campusName: s.campusName, students: st.students, marked: st.marked, status: st.status };
      });
  }

  /** Why a register cannot be changed by this user (null = it can). */
  private readOnlyReason(user: AuthUser, date: string): string | null {
    const today = schoolToday();
    if (!user.permissions.has('attendance.mark')) return 'This register is read-only for your role.';
    if (date > today) return 'Registers cannot be marked in advance.';
    if (weekdayOf(date) === 0) return 'Registers are not kept on Sundays.';
    if (this.access.restricted(user) && date < addDays(today, -TEACHER_EDIT_DAYS)) {
      return `Registers older than ${TEACHER_EDIT_DAYS} days can only be changed by the school office.`;
    }
    return null;
  }

  async register(user: AuthUser, sectionId: string, dateIn?: string) {
    const today = schoolToday();
    const date = (dateIn || today).slice(0, 10);
    if (date > today) throw badRequest('Registers cannot be opened for a future date');
    const s = await this.access.assertSection(user, sectionId);
    const d = asDate(date);
    const [students, records, reg, period] = await Promise.all([
      this.prisma.student.findMany({ where: { sectionId, status: 'active' }, orderBy: [{ rollNo: 'asc' }, { fullName: 'asc' }], select: { id: true, admissionNo: true, fullName: true, rollNo: true, risk: true } }),
      this.prisma.studentAttendance.findMany({ where: { sectionId, date: d } }),
      this.prisma.studentAttendanceRegister.findUnique({ where: { sectionId_date: { sectionId, date: d } } }),
      this.registerPeriod(s, date),
    ]);
    const byStudent = new Map(records.map((r) => [r.studentId, r]));
    const summary = { total: students.length, present: 0, late: 0, absent: 0, leave: 0, unmarked: 0 };
    const rows = students.map((st) => {
      const r = byStudent.get(st.id);
      const status = (r?.status as AttStatus | undefined) ?? null;
      if (status && status in summary) summary[status]++;
      else summary.unmarked++;
      return {
        id: st.id,
        admissionNo: st.admissionNo,
        fullName: st.fullName,
        roll: st.rollNo,
        status,
        arrivalTime: r?.arrivalTime ?? null,
        parentNotifiedAt: iso(r?.parentNotifiedAt),
        risk: st.risk,
      };
    });
    const reason = this.readOnlyReason(user, date);
    return {
      section: { id: s.id, label: s.label, room: s.room },
      date,
      isToday: date === today,
      period,
      students: rows,
      summary,
      lastMarkedBy: reg ? { name: reg.markedByName ?? 'Staff', at: reg.markedAt.toISOString() } : null,
      editable: !reason,
      readOnlyReason: reason,
    };
  }

  /** The registration period: the lesson running now (today), else the first lesson of the day. */
  private async registerPeriod(s: SectionInfo, date: string) {
    const day = timetableDay(date);
    if (day < 1 || day > 6) return null;
    const entries = (await this.prisma.timetableEntry.findMany({ where: { sectionId: s.id, day }, orderBy: { periodNo: 'asc' } })).filter(isLesson);
    if (!entries.length) return null;
    const periods = await this.prisma.timetablePeriod.findMany({ where: { campusId: s.campusId } });
    const time = (n: number) => periods.find((p) => p.periodNo === n);
    const now = schoolNow();
    const current = date === schoolToday() ? entries.find((e) => { const p = time(e.periodNo); return p && p.startsAt <= now && now < p.endsAt; }) : undefined;
    const e = current ?? entries[0];
    const p = time(e.periodNo);
    const [subjects, staff] = await Promise.all([this.access.subjectNames([e.subjectId]), this.access.employeeNames([e.substituteId ?? e.employeeId])]);
    const teacherId = e.substituteId ?? e.employeeId;
    return {
      periodNo: e.periodNo,
      startsAt: p?.startsAt ?? '',
      endsAt: p?.endsAt ?? '',
      subject: e.subjectId ? subjects.get(e.subjectId) ?? null : e.activity,
      room: e.room ?? s.room,
      teacher: teacherId ? staff.get(teacherId) ?? null : null,
    };
  }

  async save(user: AuthUser, body: { sectionId: string; date?: string; marks: { studentId: string; status: AttStatus }[] }, req: Request) {
    const today = schoolToday();
    const date = (body.date || today).slice(0, 10);
    const s = await this.access.assertSection(user, body.sectionId);
    const reason = this.readOnlyReason(user, date);
    if (reason) throw forbidden(reason);
    if (!body.marks.length) throw badRequest('Mark at least one student');

    const students = await this.prisma.student.findMany({ where: { sectionId: s.id, status: 'active' }, select: { id: true, fullName: true, firstName: true } });
    const known = new Map(students.map((x) => [x.id, x]));
    const seen = new Set<string>();
    for (const m of body.marks) {
      if (!known.has(m.studentId)) throw badRequest('One of the students is not in this class. Reload the register and try again.');
      if (seen.has(m.studentId)) throw badRequest('A student appears twice in the register');
      seen.add(m.studentId);
    }

    const d = asDate(date);
    const existing = new Map((await this.prisma.studentAttendance.findMany({ where: { sectionId: s.id, date: d } })).map((r) => [r.studentId, r]));
    const now = new Date();
    const clock = schoolNow();
    // Arrivals are timed from the school cut-off: a late mark records the time it was taken (after the cut-off).
    const cutoff = await this.settings.get<string>('attendance.cutoff_time', '08:45');
    const changedRows = body.marks.filter((m) => existing.get(m.studentId)?.status !== m.status);
    const newlyAbsent = changedRows.filter((m) => m.status === 'absent').map((m) => m.studentId);
    const newlyLate = changedRows.filter((m) => m.status === 'late').map((m) => m.studentId);

    await this.prisma.$transaction(
      changedRows.map((m) => {
        const prev = existing.get(m.studentId);
        const arrivalTime = m.status === 'late' ? prev?.arrivalTime ?? (date === today && clock >= cutoff ? clock : null) : null;
        const data = { status: m.status, arrivalTime, markedById: user.id, markedByName: user.fullName, markedAt: now };
        return this.prisma.studentAttendance.upsert({
          where: { studentId_sectionId_date: { studentId: m.studentId, sectionId: s.id, date: d } },
          create: { studentId: m.studentId, sectionId: s.id, campusId: s.campusId, date: d, ...data },
          update: data,
        });
      }),
    );

    // Counts across the whole register after the save.
    const all = await this.prisma.studentAttendance.findMany({ where: { sectionId: s.id, date: d }, select: { status: true } });
    const counts: Record<AttStatus, number> = { present: 0, late: 0, absent: 0, leave: 0 };
    for (const r of all) if (r.status in counts) counts[r.status as AttStatus]++;
    await this.prisma.studentAttendanceRegister.upsert({
      where: { sectionId_date: { sectionId: s.id, date: d } },
      create: { sectionId: s.id, campusId: s.campusId, date: d, total: students.length, ...counts, markedById: user.id, markedByName: user.fullName, markedAt: now, firstMarkedAt: now },
      update: { total: students.length, ...counts, markedById: user.id, markedByName: user.fullName, markedAt: now },
    });

    // Parent alerts for students newly marked absent or late.
    const guardians = await this.access.guardianUsers([...newlyAbsent, ...newlyLate]);
    const isToday = date === today;
    let notificationsQueued = 0;
    const notified: string[] = [];
    for (const id of [...newlyAbsent, ...newlyLate]) {
      const st = known.get(id)!;
      const absent = newlyAbsent.includes(id);
      const when = isToday ? 'today' : `on ${shortDate(date)}`;
      await this.notifications.notifyGuardians(id, {
        category: absent ? 'Attention' : 'Information',
        topic: 'attendance',
        module: 'attendance',
        campusId: s.campusId,
        deliver: true,
        title: absent ? `${st.firstName} was marked absent ${when}` : `${st.firstName} arrived late ${when}`,
        body: absent
          ? `${st.fullName} (${s.label}) was marked absent ${when}. If this is unexpected, please contact the class teacher.`
          : `${st.fullName} (${s.label}) arrived after the ${cutoff} cut-off ${when}.`,
        route: '/parent-360',
      });
      const n = guardians.get(id)?.length ?? 0;
      notificationsQueued += n;
      if (n) notified.push(id);
    }
    if (notified.length) {
      await this.prisma.studentAttendance.updateMany({ where: { sectionId: s.id, date: d, studentId: { in: notified } }, data: { parentNotifiedAt: now } });
    }

    await this.refreshAttendancePct(students.map((x) => x.id));
    const signalsRaised = await AcademicsExtensions.afterAttendance({
      sectionId: s.id, campusId: s.campusId, date, absentStudentIds: newlyAbsent, lateStudentIds: newlyLate, user,
    });

    await this.audit.record({
      user, action: 'update', module: 'attendance', entityType: 'attendance_register', entityId: `${s.id}:${date}`, campusId: s.campusId, req,
      description: `${isToday ? 'Marked' : 'Changed past'} register for ${s.label} on ${date}: ${counts.present} present, ${counts.late} late, ${counts.absent} absent, ${counts.leave} on leave (${changedRows.length} changed)`,
      metadata: { sectionId: s.id, date, changed: changedRows.length, alerts: newlyAbsent.length + newlyLate.length },
    });

    return {
      date,
      section: s.label,
      saved: body.marks.length,
      changed: changedRows.length,
      counts,
      absenceAlerts: newlyAbsent.length,
      lateNotices: newlyLate.length,
      notificationsQueued,
      signalsRaised,
    };
  }

  /** Recomputes the cached attendance percentage (present + late over marked days, current academic year). */
  async refreshAttendancePct(studentIds: string[]) {
    if (!studentIds.length) return;
    const year = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    const rows = await this.prisma.studentAttendance.groupBy({
      by: ['studentId', 'status'],
      where: { studentId: { in: studentIds }, ...(year ? { date: { gte: year.startsOn, lte: year.endsOn } } : {}) },
      _count: { _all: true },
    });
    for (const id of studentIds) {
      const mine = rows.filter((r) => r.studentId === id);
      const total = mine.reduce((n, r) => n + r._count._all, 0);
      const attended = mine.filter((r) => r.status === 'present' || r.status === 'late').reduce((n, r) => n + r._count._all, 0);
      await this.prisma.student.update({ where: { id }, data: { attendancePct: total ? round1((100 * attended) / total) : null } });
    }
  }

  /** Whole-campus figures for a date. */
  async summary(user: AuthUser, campusId: string | undefined, dateIn?: string) {
    const date = (dateIn || schoolToday()).slice(0, 10);
    const campus = this.campusFor(user, campusId);
    const sectionWhere = campus ? { campusId: campus } : {};
    const [sections, perSection, byStatus] = await Promise.all([
      this.prisma.student.groupBy({ by: ['sectionId'], where: { status: 'active', ...sectionWhere }, _count: { _all: true } }),
      this.prisma.studentAttendance.groupBy({ by: ['sectionId'], where: { date: asDate(date), ...sectionWhere }, _count: { _all: true } }),
      this.prisma.studentAttendance.groupBy({ by: ['status'], where: { date: asDate(date), ...sectionWhere }, _count: { _all: true } }),
    ]);
    const n = (st: string) => byStatus.find((b) => b.status === st)?._count._all ?? 0;
    return {
      sections: sections.length,
      sectionsMarked: sections.filter((s) => (perSection.find((p) => p.sectionId === s.sectionId)?._count._all ?? 0) >= s._count._all).length,
      students: sections.reduce((t, s) => t + s._count._all, 0),
      marked: byStatus.reduce((t, b) => t + b._count._all, 0),
      present: n('present'),
      late: n('late'),
      absent: n('absent'),
      leave: n('leave'),
    };
  }

  /** Campus for school-wide figures: the header campus for school staff, the teacher's own campus otherwise. */
  private campusFor(user: AuthUser, requested?: string): string | undefined {
    if (this.access.restricted(user)) return user.campusId ?? undefined;
    return this.scope.campus(user, requested);
  }

  async analytics(user: AuthUser, campusId?: string) {
    const today = schoolToday();
    const campus = this.campusFor(user, campusId);
    const where = campus ? { campusId: campus } : {};
    const days = recentSchoolDays(today, 11);
    const from = asDate(days[0]);
    const monthAgo = addDays(today, -28);
    const records = await this.prisma.studentAttendance.findMany({
      where: { ...where, date: { gte: asDate(monthAgo < days[0] ? monthAgo : days[0]) } },
      select: { studentId: true, sectionId: true, date: true, status: true, arrivalTime: true },
    });
    const keyed = records.map((r) => ({ ...r, day: dayKey(r.date) }));
    const dayPct = (k: string) => {
      const rows = keyed.filter((r) => r.day === k);
      if (!rows.length) return null;
      return pct(rows.filter((r) => r.status === 'present' || r.status === 'late').length, rows.length);
    };

    const todayRows = keyed.filter((r) => r.day === today);
    const attendancePct = dayPct(today);
    const earlier = days.filter((d) => d < today).slice(-10).map(dayPct).filter((v): v is number => v != null);
    const tenDayAverage = earlier.length ? round1(earlier.reduce((a, b) => a + b, 0) / earlier.length) : null;
    const absentToday = todayRows.filter((r) => r.status === 'absent');
    const lateToday = todayRows.filter((r) => r.status === 'late');

    // Late arrivals by transport route (today).
    let lateTopRoute: { route: string; n: number } | null = null;
    if (lateToday.length) {
      const transport = await this.prisma.studentTransport.findMany({ where: { studentId: { in: lateToday.map((r) => r.studentId) } }, include: { route: true } });
      const byRoute = new Map<string, number>();
      for (const t of transport) {
        const name = `Route ${t.route.code.replace(/^R0?/, '')} · ${t.route.name}`;
        byRoute.set(name, (byRoute.get(name) ?? 0) + 1);
      }
      const top = [...byRoute].sort((a, b) => b[1] - a[1])[0];
      if (top) lateTopRoute = { route: top[0], n: top[1] };
    }

    // Consecutive absences up to the latest marked day, per student.
    const byStudent = new Map<string, { day: string; status: string }[]>();
    for (const r of keyed.filter((x) => x.date >= from)) byStudent.set(r.studentId, [...(byStudent.get(r.studentId) ?? []), { day: r.day, status: r.status }]);
    let repeatAbsentees = 0;
    let frequentLate = 0;
    for (const list of byStudent.values()) {
      list.sort((a, b) => b.day.localeCompare(a.day));
      let streak = 0;
      for (const x of list) {
        if (x.status !== 'absent') break;
        streak++;
      }
      if (streak >= 3) repeatAbsentees++;
      if (list.filter((x) => x.status === 'late').length >= 3) frequentLate++;
    }
    const weekendAbsence = new Map<string, number>();
    for (const r of keyed) {
      const wd = weekdayOf(r.day);
      if (r.status === 'absent' && r.day >= monthAgo && (wd === 1 || wd === 6)) weekendAbsence.set(r.studentId, (weekendAbsence.get(r.studentId) ?? 0) + 1);
    }
    const threshold = await this.settings.get<number>('early_warning.attendance_threshold', 82);
    const belowThreshold = await this.prisma.student.count({ where: { status: 'active', ...where, attendancePct: { lt: threshold } } });

    // Class-wise today.
    const sectionIds = [...new Set(todayRows.map((r) => r.sectionId))];
    const sections = await this.access.sectionInfo(sectionIds);
    const byClass = new Map<string, { grade: number; name: string; present: number; marked: number }>();
    for (const r of todayRows) {
      const s = sections.get(r.sectionId);
      if (!s) continue;
      const k = `${s.gradeLevel}|${s.className}`;
      const cur = byClass.get(k) ?? { grade: s.gradeLevel, name: s.className, present: 0, marked: 0 };
      cur.marked++;
      if (r.status === 'present' || r.status === 'late') cur.present++;
      byClass.set(k, cur);
    }
    const classes = [...byClass.values()].sort((a, b) => a.grade - b.grade || a.name.localeCompare(b.name));

    // Late arrivals in ten-minute bands over the last seven days.
    const weekAgo = addDays(today, -6);
    const bins = new Map<string, number>();
    for (const r of keyed) {
      if (r.status !== 'late' || !r.arrivalTime || r.day < weekAgo) continue;
      const [h, m] = r.arrivalTime.split(':').map(Number);
      const mins = h * 60 + Math.floor(m / 10) * 10;
      const label = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      bins.set(label, (bins.get(label) ?? 0) + 1);
    }
    const lateLabels = [...bins.keys()].sort();

    const trendDays = days.slice(-10).filter((k) => dayPct(k) != null);
    return {
      date: today,
      kpis: {
        attendancePct,
        delta: attendancePct != null && tenDayAverage != null ? round1(attendancePct - tenDayAverage) : null,
        tenDayAverage,
        absent: absentToday.length,
        late: lateToday.length,
        lateTopRoute,
        repeatAbsentees,
      },
      trend: { labels: trendDays.map(shortDate), values: trendDays.map((k) => dayPct(k)!) },
      byGrade: { labels: classes.map((c) => c.name), present: classes.map((c) => pct(c.present, c.marked)) },
      lateByTime: { labels: lateLabels, values: lateLabels.map((l) => bins.get(l)!) },
      patterns: [
        { label: 'Absent 3+ days in a row', value: repeatAbsentees, note: 'for Early Warning review' },
        { label: 'Below attendance threshold', value: belowThreshold, note: `under ${threshold}% this year` },
        { label: 'Frequent late arrivals', value: frequentLate, note: '3+ late in ten school days' },
        { label: 'Monday and Saturday absences', value: [...weekendAbsence.values()].filter((n) => n >= 2).length, note: '2+ in four weeks' },
        { label: 'Absent today', value: absentToday.length, note: 'parents alerted' },
      ],
    };
  }
}
