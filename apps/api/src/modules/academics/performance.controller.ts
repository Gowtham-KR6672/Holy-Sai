import { Controller, Get, Query } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { paged } from '../../common/envelope';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { dayKey, loadTerms, mean, round1, schoolToday, type Term } from './academics.util';

/** Cambridge expectation bands on the term average. */
const EXPECTATION = { above: 80, at: 65 };
const band = (avg: number): 'above' | 'at' | 'below' => (avg >= EXPECTATION.above ? 'above' : avg >= EXPECTATION.at ? 'at' : 'below');

class PerfQuery {
  @IsOptional() @IsString() campusId?: string;
  @IsOptional() @IsString() grade?: string;
}

class PerfStudentsQuery extends ListQuery {
  @IsOptional() @IsString() grade?: string;
  @IsOptional() @IsIn(['above', 'at', 'below']) band?: string;
  @IsOptional() @IsString() subjectId?: string;
}

interface Mark { studentId: string; subjectId: string; pct: number; term: number; classId: string }

@Controller('academics/performance')
@RequirePermissions('students.read', 'students.read_assigned')
export class PerformanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /** Marks of the students in scope, tagged with their term; plus which terms are "current" and "previous". */
  private async load(user: AuthUser, campusId?: string, grade?: string) {
    const where: Prisma.StudentWhereInput = {
      AND: [await this.scope.studentWhere(user, campusId), { status: 'active' }, grade ? { section: { class: { gradeLevel: Number(grade) } } } : {}],
    };
    const students = await this.prisma.student.findMany({
      where,
      select: { id: true, admissionNo: true, fullName: true, risk: true, section: { select: { name: true, class: { select: { id: true, name: true, gradeLevel: true } } } } },
    });
    const terms = await loadTerms(this.prisma);
    const raw = students.length
      ? await this.prisma.assessmentMark.findMany({
          where: { studentId: { in: students.map((s) => s.id) }, isAbsent: false, marks: { not: null } },
          select: { studentId: true, marks: true, assessment: { select: { subjectId: true, maxMarks: true, heldOn: true, classId: true } } },
        })
      : [];
    const termIndex = (key: string) => {
      let idx = -1;
      terms.forEach((t, i) => { if (t.start <= key) idx = i; });
      return idx;
    };
    const marks: Mark[] = raw
      .filter((m) => m.assessment.maxMarks > 0)
      .map((m) => ({ studentId: m.studentId, subjectId: m.assessment.subjectId, pct: (100 * (m.marks ?? 0)) / m.assessment.maxMarks, term: termIndex(dayKey(m.assessment.heldOn)), classId: m.assessment.classId }));
    const today = schoolToday();
    const withMarks = [...new Set(marks.map((m) => m.term))].filter((i) => i >= 0 && terms[i].start <= today).sort((a, b) => a - b);
    const current = withMarks.length ? withMarks[withMarks.length - 1] : -1;
    const previous = current > 0 ? current - 1 : -1;
    return { students, terms, marks, current, previous };
  }

  @Get()
  async overview(@Query() q: PerfQuery, @CurrentUser() user: AuthUser) {
    const { terms, marks, current, previous } = await this.load(user, q.campusId, q.grade);
    const label = (i: number): string | null => (i >= 0 ? (terms[i] as Term).label : null);
    const avgByStudent = (t: number) => {
      const m = new Map<string, number[]>();
      for (const x of marks) if (x.term === t) m.set(x.studentId, [...(m.get(x.studentId) ?? []), x.pct]);
      return new Map([...m].map(([id, ps]) => [id, mean(ps)!]));
    };
    const cur = avgByStudent(current);
    const prev = previous >= 0 ? avgByStudent(previous) : new Map<string, number>();
    const share = (m: Map<string, number>, b: string) => (m.size ? Math.round((100 * [...m.values()].filter((v) => band(v) === b).length) / m.size) : 0);
    const average = cur.size ? round1(mean([...cur.values()])!) : null;
    const prevAverage = prev.size ? round1(mean([...prev.values()])!) : null;

    const subjects = await this.prisma.subject.findMany({ where: { id: { in: [...new Set(marks.map((m) => m.subjectId))] } }, select: { id: true, name: true } });
    const subjName = new Map(subjects.map((s) => [s.id, s.name]));
    const subjAvg = (t: number, sid: string) => mean(marks.filter((m) => m.term === t && m.subjectId === sid).map((m) => m.pct));
    const subjectAverages = subjects
      .filter((s) => marks.some((m) => m.term === current && m.subjectId === s.id))
      .map((s) => ({ subject: s.name, current: round1(subjAvg(current, s.id) ?? 0), previous: round1(previous >= 0 ? subjAvg(previous, s.id) ?? 0 : 0) }))
      .sort((a, b) => a.subject.localeCompare(b.subject));

    // Grade-and-subject combinations with the largest term-on-term change.
    const classes = await this.prisma.schoolClass.findMany({ where: { id: { in: [...new Set(marks.map((m) => m.classId))] } }, select: { id: true, name: true } });
    const className = new Map(classes.map((c) => [c.id, c.name]));
    const groups = new Map<string, { title: string; cur: number[]; prev: number[]; students: Set<string> }>();
    if (previous >= 0) {
      for (const m of marks) {
        if (m.term !== current && m.term !== previous) continue;
        const title = `${className.get(m.classId) ?? 'Grade'} ${subjName.get(m.subjectId) ?? ''}`.trim();
        const g = groups.get(title) ?? { title, cur: [], prev: [], students: new Set<string>() };
        if (m.term === current) {
          g.cur.push(m.pct);
          g.students.add(m.studentId);
        } else g.prev.push(m.pct);
        groups.set(title, g);
      }
    }
    const movers = [...groups.values()]
      .filter((g) => g.cur.length && g.prev.length)
      .map((g) => {
        const c = round1(mean(g.cur)!);
        const p = round1(mean(g.prev)!);
        return { title: g.title, delta: round1(c - p), current: c, previous: p, students: g.students.size };
      })
      .filter((m) => m.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 5);

    const hasPrev = prev.size > 0;
    return {
      currentTerm: label(current),
      previousTerm: label(previous),
      expectation: EXPECTATION,
      kpis: {
        average,
        averageDelta: average != null && prevAverage != null ? round1(average - prevAverage) : null,
        students: cur.size,
        abovePct: share(cur, 'above'),
        aboveDelta: hasPrev ? share(cur, 'above') - share(prev, 'above') : 0,
        atPct: share(cur, 'at'),
        atDelta: hasPrev ? share(cur, 'at') - share(prev, 'at') : 0,
        belowPct: share(cur, 'below'),
        belowDelta: hasPrev ? share(cur, 'below') - share(prev, 'below') : 0,
      },
      subjectAverages,
      movers,
    };
  }

  @Get('students')
  async students(@Query() q: PerfStudentsQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q, 10);
    const { students, marks, current, previous } = await this.load(user, q.campusId, q.grade);
    const subjects = await this.prisma.subject.findMany({ where: { id: { in: [...new Set(marks.map((m) => m.subjectId))] } }, select: { id: true, name: true } });
    const subjName = new Map(subjects.map((s) => [s.id, s.name]));
    const term = q.q?.trim().toLowerCase();
    let rows = students.flatMap((s) => {
      const mine = marks.filter((m) => m.studentId === s.id && m.term === current && (!q.subjectId || m.subjectId === q.subjectId));
      if (!mine.length) return [];
      const average = round1(mean(mine.map((m) => m.pct))!);
      const before = mean(marks.filter((m) => m.studentId === s.id && m.term === previous && (!q.subjectId || m.subjectId === q.subjectId)).map((m) => m.pct));
      const bySubject = new Map<string, number[]>();
      for (const m of marks.filter((x) => x.studentId === s.id && x.term === current)) bySubject.set(m.subjectId, [...(bySubject.get(m.subjectId) ?? []), m.pct]);
      const ranked = [...bySubject].map(([sid, ps]) => ({ sid, avg: mean(ps)! })).sort((a, b) => a.avg - b.avg);
      return [{
        id: s.id,
        admissionNo: s.admissionNo,
        fullName: s.fullName,
        grade: s.section.class.name,
        section: s.section.name,
        risk: s.risk,
        average,
        target: null as number | null,
        trend: before == null || previous < 0 ? null : round1(average - before),
        weakest: ranked.length > 1 ? subjName.get(ranked[0].sid) ?? null : null,
        strongest: ranked.length > 1 ? subjName.get(ranked[ranked.length - 1].sid) ?? null : null,
        band: band(average),
      }];
    });
    if (q.band) rows = rows.filter((r) => r.band === q.band);
    if (term) rows = rows.filter((r) => r.fullName.toLowerCase().includes(term) || r.admissionNo.toLowerCase().includes(term));
    const dir = q.dir === 'desc' ? -1 : 1;
    const key = q.sort ?? 'average';
    rows.sort((a, b) => {
      const c = key === 'name' ? a.fullName.localeCompare(b.fullName) : key === 'trend' ? (a.trend ?? -999) - (b.trend ?? -999) : key === 'target' ? (a.target ?? -1) - (b.target ?? -1) : a.average - b.average;
      return c * dir || a.fullName.localeCompare(b.fullName);
    });
    return paged(rows.slice(p.skip, p.skip + p.take), rows.length, p);
  }
}
