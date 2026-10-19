import { Controller, Get } from '@nestjs/common';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AcademicsAccess } from './academics.access';
import { AcademicsExtensions } from './academics.extensions';
import { AssessmentsService } from './assessments.service';
import { AttendanceService } from './attendance.service';
import { asDate, DAY_NAMES, dayKey, dayKeyOrNull, schoolNow, schoolToday, timetableDay } from './academics.util';
import { isLesson, TimetableService } from './timetable.service';

const WEEKDAYS = ['Sunday', ...DAY_NAMES];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The teacher's day: classes, periods, registers to mark, marks pending, homework, tasks and the watchlist. */
@Controller('academics/teacher-dashboard')
export class TeacherDashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly access: AcademicsAccess,
    private readonly tt: TimetableService,
    private readonly attendance: AttendanceService,
    private readonly assessments: AssessmentsService,
  ) {}

  @Get()
  @RequirePermissions('attendance.mark', 'academics.read')
  async dashboard(@CurrentUser() user: AuthUser) {
    await this.tt.expireCovers();
    const today = schoolToday();
    const day = timetableDay(today);
    const now = schoolNow();
    const tasks = await this.tasks(user, today);
    const base = { date: today, dayName: WEEKDAYS[asDate(today).getUTCDay()] };
    const emp = user.employeeId ? await this.prisma.employee.findUnique({ where: { id: user.employeeId } }) : null;
    if (!emp) {
      return {
        ...base,
        lede: tasks.length ? `${plural(tasks.length, 'task')} waiting for you.` : 'Your account is not linked to a staff record yet.',
        employee: null, kpis: null, classes: [], today: [], watchlist: [], watchCount: 0, tasks, homework: [],
      };
    }

    const sectionIds = await this.scope.teacherSectionIds(user);
    const [sections, entries, periods] = await Promise.all([
      this.access.sectionInfo(sectionIds),
      this.prisma.timetableEntry.findMany({ where: { OR: [{ employeeId: emp.id }, { substituteId: emp.id }] }, orderBy: [{ day: 'asc' }, { periodNo: 'asc' }] }),
      this.tt.periods(emp.campusId),
    ]);
    const lessons = entries.filter(isLesson);
    // Periods that are mine on a given date: my own (unless someone covers them that day) plus covers I take that day.
    const mineOn = (date: string, d: number) =>
      lessons.filter((e) => e.day === d && (
        (e.employeeId === emp.id && !(e.substituteId && e.substituteId !== emp.id && e.coverDate && dayKey(e.coverDate) === date))
        || (e.substituteId === emp.id && !!e.coverDate && dayKey(e.coverDate) === date)
      ));
    const todays = day >= 1 && day <= 6 ? mineOn(today, day) : [];
    const subjects = await this.access.subjectNames(lessons.map((e) => e.subjectId));
    const what = (e: (typeof lessons)[number]) => (e.subjectId ? subjects.get(e.subjectId) ?? 'Lesson' : e.activity ?? 'Lesson');
    const timeOf = (n: number) => periods.find((p) => p.periodNo === n);

    // Today's periods (the full bell schedule, with free periods) when the teacher has lessons today.
    const todayRows = todays.length
      ? periods.map((p) => {
          const e = todays.find((x) => x.periodNo === p.periodNo);
          const state: 'now' | 'done' | 'upcoming' = p.startsAt <= now && now < p.endsAt ? 'now' : p.endsAt <= now ? 'done' : 'upcoming';
          if (!e) return { periodNo: p.periodNo, startsAt: p.startsAt, endsAt: p.endsAt, what: 'Free period', where: '', state, free: true };
          const s = sections.get(e.sectionId);
          const cover = e.substituteId === emp.id && e.employeeId !== emp.id;
          return {
            periodNo: p.periodNo, startsAt: p.startsAt, endsAt: p.endsAt,
            what: `${what(e)} · ${s?.label ?? ''}`.trim(),
            where: `Room ${e.room ?? s?.room ?? '—'}`,
            state, cover, sectionId: e.sectionId,
          };
        })
      : [];

    // Registers and the next lesson for each class.
    const status = await this.attendance.sectionStatus(sectionIds, today);
    const nextFor = (sectionId: string) => {
      const later = todays.filter((e) => e.sectionId === sectionId && (timeOf(e.periodNo)?.startsAt ?? '') > now);
      if (later.length) return `today P${later[0].periodNo} · ${timeOf(later[0].periodNo)?.startsAt ?? ''}`;
      for (let i = 1; i <= 7; i++) {
        const d = (day + i) % 7; // 0 = Sunday
        if (d === 0) continue;
        const hit = lessons.filter((e) => e.sectionId === sectionId && e.day === d && e.employeeId === emp.id);
        if (hit.length) return `${SHORT_DAYS[d]} P${hit[0].periodNo}`;
      }
      return '—';
    };
    const classes = [...sections.values()]
      .sort((a, b) => a.gradeLevel - b.gradeLevel || a.label.localeCompare(b.label))
      .map((s) => {
        const mySubjects = [...new Set(lessons.filter((e) => e.sectionId === s.id && e.employeeId === emp.id).map(what))];
        const st = status.get(s.id) ?? { students: 0, marked: 0, status: 'Not marked' };
        const isClassTeacher = s.classTeacherId === emp.id;
        return {
          id: s.id,
          name: s.label,
          subject: mySubjects.length ? mySubjects.join(' & ') : isClassTeacher ? 'Form class' : 'Cover',
          students: st.students,
          marked: st.marked,
          next: nextFor(s.id),
          attendance: st.status,
          isClassTeacher,
          hasClassToday: todays.some((e) => e.sectionId === s.id),
        };
      });
    const schoolDay = day >= 1 && day <= 6;
    const toMark = schoolDay ? classes.filter((c) => c.attendance !== 'Marked' && c.students > 0 && (c.isClassTeacher || c.hasClassToday)) : [];

    // Assessments in my classes whose marks are not all in.
    const classIds = [...new Set([...sections.values()].map((s) => s.classId))];
    const active = sectionIds.length
      ? await this.prisma.assessment.findMany({
          where: { status: { in: ['Scheduled', 'In Progress'] }, heldOn: { lte: asDate(today) }, OR: [{ sectionId: { in: sectionIds } }, { sectionId: null, classId: { in: classIds } }] },
          include: { _count: { select: { marks: true } } },
          orderBy: { heldOn: 'asc' },
        })
      : [];
    const pending = (await this.assessments.rows(active)).filter((r) => r.entered < r.of);

    // Open homework in my classes.
    const hw = sectionIds.length
      ? await this.prisma.homework.findMany({ where: { sectionId: { in: sectionIds }, status: 'Open' }, orderBy: { dueOn: 'asc' }, take: 5, include: { _count: { select: { submissions: true } } } })
      : [];
    const hwSubjects = await this.access.subjectNames(hw.map((h) => h.subjectId));
    const homework = hw.map((h) => ({
      id: h.id, title: h.title, subject: hwSubjects.get(h.subjectId) ?? '', sectionLabel: sections.get(h.sectionId)?.label ?? '',
      dueOn: dayKey(h.dueOn), submitted: h._count.submissions, of: status.get(h.sectionId)?.students ?? 0,
    }));

    const studentIds = sectionIds.length ? (await this.prisma.student.findMany({ where: { sectionId: { in: sectionIds }, status: 'active' }, select: { id: true } })).map((s) => s.id) : [];
    const watch = await AcademicsExtensions.watchlist(studentIds, 5);
    const students = classes.reduce((n, c) => n + c.students, 0);

    const lede = [
      !schoolDay ? 'No school today.' : todays.length ? `${plural(todays.length, 'period')} today across ${plural(new Set(todays.map((e) => e.sectionId)).size, 'class', 'classes')}.` : 'No lessons on your timetable today.',
      toMark.length ? `${plural(toMark.length, 'register')} still to mark.` : schoolDay && classes.length ? 'Registers are up to date.' : null,
      pending.length ? `Marks pending for ${plural(pending.length, 'assessment')}.` : null,
    ].filter(Boolean).join(' ');

    return {
      ...base,
      lede,
      employee: { id: emp.id, fullName: emp.fullName, designation: emp.designation },
      kpis: {
        classes: classes.length,
        students,
        toMark: toMark.length,
        toMarkNames: toMark.slice(0, 3).map((c) => c.name),
        marksPending: pending.length,
        marksPendingFoot: pending.length ? `${pending[0].code} ${pending[0].grade} ${pending[0].subject} — ${pending[0].entered}/${pending[0].of}${pending.length > 1 ? ` · ${pending.length - 1} more` : ''}` : null,
        watch: watch.total,
      },
      classes,
      today: todayRows,
      watchlist: watch.rows,
      watchCount: watch.total,
      tasks,
      homework,
    };
  }

  private async tasks(user: AuthUser, today: string) {
    const rows = await this.prisma.task.findMany({
      where: { assigneeId: user.id, status: { not: 'Completed' } },
      orderBy: [{ dueOn: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 6,
    });
    return rows.map((t) => {
      const due = dayKeyOrNull(t.dueOn);
      return { id: t.id, title: t.title, module: t.module, dueOn: due, route: t.route, overdue: !!due && due < today, priority: t.priority };
    });
  }
}
