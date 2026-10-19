import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { EarlyWarningService } from './early-warning.service';
import { asDate, dayKey, gradeIn, money, pct, schoolToday } from './intel.util';

/**
 * Questions answered from live school records rather than documents (permission-aware), and the
 * record-based facts the WhatsApp assistant may quote: campuses and curriculum, fee structure,
 * calendar and transport.
 */
export interface LiveResult {
  topic: string;
  found: boolean;
  restricted?: boolean;
  answer: string;
  confidence: 'High' | 'Medium' | 'Low';
  chart?: { label: string; value: number }[];
  sources: { id: null; doc: string; section: string | null; updated: string; live: true }[];
}

const IST = 330 * 60_000;
const LONG_DATE = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const longDate = (d: Date) => LONG_DATE.format(d);
const monthStart = () => {
  const n = new Date(Date.now() + IST);
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1) - IST);
};

const can = (u: AuthUser, ...p: string[]) => p.some((x) => u.permissions.has(x));

@Injectable()
export class KnowledgeLive {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ew: EarlyWarningService,
  ) {}

  /** The live record areas this person may ask about. */
  sources(user: AuthUser): { title: string; detail: string }[] {
    const out: { title: string; detail: string }[] = [];
    if (can(user, 'attendance.read', 'students.read', 'students.read_assigned')) out.push({ title: 'Attendance', detail: 'Today’s registers for the students you can see' });
    if (can(user, 'admissions.read', 'admissions.manage')) out.push({ title: 'Admissions', detail: 'Enquiries this month, by source and stage' });
    out.push({ title: 'Calendar', detail: 'Upcoming events and parent–teacher meetings' });
    out.push({ title: 'Fee structure', detail: 'Approved fees for the current academic year' });
    if (can(user, 'transport.read', 'transport.manage', 'safety.read')) out.push({ title: 'Transport', detail: 'Routes and delays right now' });
    if (can(user, 'earlywarning.read', 'earlywarning.manage')) out.push({ title: 'Early Warning', detail: 'Risk bands and signals awaiting review' });
    return out;
  }

  private src(doc: string, section: string | null = null) {
    return [{ id: null, doc: `Live records — ${doc}`, section, updated: new Date().toISOString(), live: true as const }];
  }

  private denied(topic: string, what: string): LiveResult {
    return { topic, found: false, restricted: true, answer: `Your role does not include access to ${what}, so this cannot be answered for you. Ask a colleague who manages ${what}.`, confidence: 'Low', sources: [] };
  }

  /** A live answer when the question is about records; null when it should go to documents. */
  async answer(user: AuthUser, question: string, campusId?: string): Promise<LiveResult | null> {
    const q = question.toLowerCase();
    const campus = this.scope.campus(user, campusId);
    if (/\b(admissions?|enquir(y|ies)|leads?)\b/.test(q) && /source|channel|month|how many|number|count|show|week|today|year|stage|funnel|by\b/.test(q)) {
      if (!can(user, 'admissions.read', 'admissions.manage')) return this.denied('admissions', 'admissions records');
      return this.admissions(campus);
    }
    if (/\b(attendance|absent|absentees|present today|marked today)\b/.test(q) && !/polic|procedure|rule/.test(q)) {
      if (!can(user, 'attendance.read', 'students.read', 'students.read_assigned')) return this.denied('attendance', 'attendance records');
      return this.attendance(user, campusId);
    }
    if (/\bptm\b|parent[\s-]*teacher|parents?['’]? meeting/.test(q) && !/polic|procedure/.test(q)) return this.ptm(campus, gradeIn(question));
    if (/\b(at risk|early warning|signals?|interventions?)\b/.test(q) && !/polic|procedure/.test(q)) {
      if (!can(user, 'earlywarning.read', 'earlywarning.manage')) return this.denied('earlywarning', 'Early Warning');
      return this.earlyWarning(user, campusId);
    }
    if (/\b(fees?|tuition)\b/.test(q) && (gradeIn(question) || /how much|structure|amount|term/.test(q)) && !/polic|refund|concession|late/.test(q)) {
      return this.fees(campus, gradeIn(question));
    }
    if (/\b(bus|buses|routes?|transport)\b/.test(q) && /delay|late|running|now|today|status|where/.test(q)) {
      if (!can(user, 'transport.read', 'transport.manage', 'safety.read')) return this.denied('transport', 'transport records');
      return this.transport(campus);
    }
    if (/\b(next|upcoming|when is|calendar|holiday|events?)\b/.test(q) && /\b(event|holiday|day|calendar|function|celebration|exam|sports|annual|break|vacation)\b/.test(q) && !/polic|procedure/.test(q)) {
      return this.events(campus, question);
    }
    return null;
  }

  private async campusName(campusId?: string | null) {
    if (!campusId) return null;
    return (await this.prisma.campus.findUnique({ where: { id: campusId }, select: { name: true } }))?.name ?? null;
  }

  private async admissions(campusId?: string): Promise<LiveResult> {
    const where: Prisma.AdmissionLeadWhereInput = { createdAt: { gte: monthStart() }, ...(campusId ? { campusId } : {}) };
    const [bySource, enrolled, name] = await Promise.all([
      this.prisma.admissionLead.groupBy({ by: ['source'], where, _count: { _all: true } }),
      this.prisma.admissionLead.count({ where: { ...where, stage: 'Enrolled' } }),
      this.campusName(campusId),
    ]);
    const rows = bySource.map((r) => ({ label: r.source, value: r._count._all })).sort((a, b) => b.value - a.value);
    const total = rows.reduce((n, r) => n + r.value, 0);
    const where2 = name ? ` at ${name}` : ' across all campuses';
    const answer = total
      ? `${total} enquir${total === 1 ? 'y has' : 'ies have'} been received this month${where2}. By source: ${rows.map((r) => `${r.label} ${r.value} (${pct(r.value, total)}%)`).join(', ')}.\n\n${enrolled} of them ${enrolled === 1 ? 'has' : 'have'} enrolled so far.`
      : `No enquiries have been recorded this month${where2} yet.`;
    return { topic: 'admissions', found: true, answer, confidence: 'High', chart: rows, sources: this.src('Admissions', 'Enquiries this month') };
  }

  private async attendance(user: AuthUser, campusId?: string): Promise<LiveResult> {
    const studentWhere: Prisma.StudentWhereInput = { AND: [await this.scope.studentWhere(user, campusId), { status: 'active' }] };
    const ids = (await this.prisma.student.findMany({ where: studentWhere, select: { id: true } })).map((s) => s.id);
    const rows = ids.length
      ? await this.prisma.studentAttendance.groupBy({ by: ['status'], where: { studentId: { in: ids }, date: asDate(schoolToday()) }, _count: { _all: true } })
      : [];
    const n = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
    const marked = rows.reduce((t, r) => t + r._count._all, 0);
    const chart = [{ label: 'Present', value: n('present') }, { label: 'Late', value: n('late') }, { label: 'Absent', value: n('absent') }, { label: 'On leave', value: n('leave') }];
    const answer = marked
      ? `Today ${marked} of ${ids.length} students you can see have been marked: ${n('present')} present, ${n('late')} late, ${n('absent')} absent and ${n('leave')} on leave — ${pct(n('present') + n('late'), marked)}% attendance so far.`
      : `No registers have been marked today for the ${ids.length} students you can see.`;
    return { topic: 'attendance', found: true, answer, confidence: 'High', chart: marked ? chart : undefined, sources: this.src('Attendance', 'Today') };
  }

  async nextPtm(campusId?: string | null, grade?: number | null) {
    const today = asDate(schoolToday());
    const sessions = await this.prisma.ptmSession.findMany({
      where: { sessionDate: { gte: today }, ...(campusId ? { campusId } : {}) },
      orderBy: [{ sessionDate: 'asc' }, { startsAt: 'asc' }],
      take: 200,
    });
    const sections = new Map(
      (await this.prisma.section.findMany({ where: { id: { in: [...new Set(sessions.map((s) => s.sectionId))] } }, select: { id: true, name: true, class: { select: { name: true, gradeLevel: true } } } }))
        .map((s) => [s.id, s]),
    );
    const matching = sessions.filter((s) => !grade || sections.get(s.sectionId)?.class.gradeLevel === grade);
    const events = await this.prisma.commEvent.findMany({
      where: { eventType: 'PTM', status: 'Published', startsOn: { gte: today }, ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}) },
      orderBy: { startsOn: 'asc' },
      take: 20,
    });
    const event = events.find((e) => {
      const a = e.audience as { kind?: string; grades?: number[] } | null;
      return !grade || a?.kind !== 'grades' || (a.grades ?? []).includes(grade);
    });
    return { sessions: matching, sections, event };
  }

  private async ptm(campusId?: string, grade?: number | null): Promise<LiveResult> {
    const { sessions, sections, event } = await this.nextPtm(campusId, grade);
    const label = grade ? `Grade ${grade} ` : '';
    const first = sessions[0];
    if (!first && !event) {
      return { topic: 'events', found: false, answer: `No upcoming ${label}parent–teacher meeting is on the calendar yet.`, confidence: 'Low', sources: this.src('Calendar', 'Parent–teacher meetings') };
    }
    let answer: string;
    if (first && (!event || first.sessionDate <= event.startsOn)) {
      const sameDay = sessions.filter((s) => s.sessionDate.getTime() === first.sessionDate.getTime());
      const list = sameDay.slice(0, 4).map((s) => {
        const sec = sections.get(s.sectionId);
        return `${s.subjectLabel}${sec && !s.subjectLabel.includes(sec.class.name) ? ` (${sec.class.name}${sec.name})` : ''} from ${s.startsAt}${s.venue ? `, ${s.venue}` : ''}`;
      });
      answer = `The next ${label}PTM is on ${longDate(first.sessionDate)}. Sessions that day: ${list.join('; ')}${sameDay.length > 4 ? `; and ${sameDay.length - 4} more` : ''}.`;
    } else {
      answer = `The next ${label}PTM is on ${longDate(event!.startsOn)}${event!.startsAt ? ` at ${event!.startsAt}` : ''}${event!.venue ? `, ${event!.venue}` : ''} — “${event!.title}” (${event!.audienceLabel}).`;
    }
    return { topic: 'events', found: true, answer, confidence: 'High', sources: this.src('Calendar', 'Parent–teacher meetings') };
  }

  async upcomingEvents(campusId?: string | null, familiesOnly = false, take = 6) {
    const rows = await this.prisma.commEvent.findMany({
      where: { status: 'Published', startsOn: { gte: asDate(schoolToday()) }, ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}) },
      orderBy: { startsOn: 'asc' },
      take: 40,
    });
    return rows.filter((e) => !familiesOnly || (e.audience as { kind?: string } | null)?.kind !== 'staff').slice(0, take);
  }

  private async events(campusId: string | undefined, question: string): Promise<LiveResult> {
    const all = await this.upcomingEvents(campusId, false, 40);
    const words = question.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !['when', 'next', 'what', 'event', 'events', 'upcoming', 'calendar', 'school'].includes(w)) ?? [];
    const hit = words.length ? all.filter((e) => words.some((w) => `${e.title} ${e.eventType}`.toLowerCase().includes(w))) : [];
    const list = (hit.length ? hit : all).slice(0, 5);
    if (!list.length) return { topic: 'events', found: false, answer: 'No upcoming events are on the school calendar.', confidence: 'Low', sources: this.src('Calendar', 'Upcoming events') };
    const answer = list.map((e) => `${e.title} — ${longDate(e.startsOn)}${e.startsAt ? ` at ${e.startsAt}` : ''}${e.venue ? `, ${e.venue}` : ''} (${e.audienceLabel})`).join('\n\n');
    return { topic: 'events', found: true, answer, confidence: hit.length ? 'High' : 'Medium', sources: this.src('Calendar', 'Upcoming events') };
  }

  /** Fee structure lines for a grade (or every grade) in the current academic year. */
  async feeLines(campusId?: string | null, grade?: number | null) {
    const year = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    const classes = await this.prisma.schoolClass.findMany({
      where: { ...(campusId ? { campusId } : {}), ...(grade ? { gradeLevel: grade } : {}) },
      select: { id: true, name: true, gradeLevel: true, campus: { select: { name: true } } },
    });
    const lines = classes.length
      ? await this.prisma.financeFeeStructure.findMany({
          where: { classId: { in: classes.map((c) => c.id) }, status: 'Active', ...(year ? { OR: [{ academicYearId: year.id }, { academicYearId: null }] } : {}) },
          include: { feeHead: { select: { name: true, sortOrder: true } } },
          orderBy: [{ dueDate: 'asc' }],
        })
      : [];
    return { year: year?.label ?? null, classes: new Map(classes.map((c) => [c.id, c])), lines };
  }

  private async fees(campusId?: string, grade?: number | null): Promise<LiveResult> {
    const { year, classes, lines } = await this.feeLines(campusId, grade);
    if (!lines.length) {
      return { topic: 'fees', found: false, answer: `No approved fee structure${grade ? ` for Grade ${grade}` : ''} is recorded for the current academic year yet.`, confidence: 'Low', sources: this.src('Fee structure') };
    }
    if (grade) {
      const byCampus = new Map<string, typeof lines>();
      for (const l of lines) {
        const c = classes.get(l.classId)!;
        byCampus.set(c.campus.name, [...(byCampus.get(c.campus.name) ?? []), l]);
      }
      const paras = [...byCampus.entries()].map(([campus, ls]) => {
        const terms = new Map<string, typeof ls>();
        for (const l of ls) terms.set(l.term, [...(terms.get(l.term) ?? []), l]);
        const parts = [...terms.entries()].map(([term, tl]) => `${term} ${money(tl.reduce((n, l) => n + Number(l.amount), 0))} (${tl.map((l) => `${l.feeHead.name} ${money(Number(l.amount))}`).join(', ')}; due ${dayKey(tl[0].dueDate)})`);
        return `Grade ${grade} fees at ${campus}${year ? ` for ${year}` : ''}: ${parts.join('; ')}. Total ${money(ls.reduce((n, l) => n + Number(l.amount), 0))}.`;
      });
      const chart = [...new Map(lines.map((l) => [l.feeHead.name, 0])).keys()].map((head) => ({ label: head, value: lines.filter((l) => l.feeHead.name === head).reduce((n, l) => n + Number(l.amount), 0) }));
      return { topic: 'fees', found: true, answer: paras.join('\n\n'), confidence: 'High', chart, sources: this.src('Fee structure', year) };
    }
    const byGrade = new Map<number, number>();
    for (const l of lines) {
      const g = classes.get(l.classId)!.gradeLevel;
      byGrade.set(g, (byGrade.get(g) ?? 0) + Number(l.amount));
    }
    const chart = [...byGrade.entries()].sort((a, b) => a[0] - b[0]).map(([g, v]) => ({ label: `Grade ${g}`, value: Math.round(v) }));
    const answer = `Annual fees${year ? ` for ${year}` : ''} by grade${campusId ? '' : ' (all campuses combined where they differ)'}: ${chart.map((c) => `${c.label} ${money(c.value)}`).join(', ')}. Ask about a specific grade for the term-by-term breakdown.`;
    return { topic: 'fees', found: true, answer, confidence: 'Medium', chart, sources: this.src('Fee structure', year) };
  }

  private async transport(campusId?: string): Promise<LiveResult> {
    const routes = await this.prisma.transportRoute.findMany({ where: { isActive: true, ...(campusId ? { campusId } : {}) }, select: { id: true, code: true, name: true, status: true }, orderBy: { code: 'asc' } });
    const profiles = new Map((await this.prisma.transportRouteProfile.findMany({ where: { routeId: { in: routes.map((r) => r.id) } } })).map((p) => [p.routeId, p]));
    const today = schoolToday();
    const rows = routes.map((r) => {
      const p = profiles.get(r.id);
      const current = p?.runDate && dayKey(p.runDate) === today;
      return { label: r.code, name: r.name, status: current ? r.status : 'scheduled', delay: current ? p!.delayMinutes : 0 };
    });
    const delayed = rows.filter((r) => r.delay > 0 || r.status === 'delayed');
    if (!rows.length) return { topic: 'transport', found: false, answer: 'No active bus routes are set up.', confidence: 'Low', sources: this.src('Transport') };
    const answer = delayed.length
      ? `${delayed.length} of ${rows.length} routes are delayed right now: ${delayed.map((r) => `${r.label} ${r.name} (${r.delay} min)`).join(', ')}. The other routes are on time.`
      : `All ${rows.length} routes are on time right now.`;
    return { topic: 'transport', found: true, answer, confidence: 'High', chart: rows.map((r) => ({ label: r.label, value: r.delay })), sources: this.src('Transport', 'Routes today') };
  }

  private async earlyWarning(user: AuthUser, campusId?: string): Promise<LiveResult> {
    const ids = (await this.prisma.student.findMany({ where: { AND: [await this.scope.studentWhere(user, campusId), { status: 'active' }] }, select: { id: true } })).map((s) => s.id);
    const states = await this.ew.states(ids);
    const count = (b: string) => [...states.values()].filter((s) => s.band === b).length;
    const awaiting = ids.length ? await this.prisma.earlyWarningSignal.count({ where: { studentId: { in: ids }, decision: null, closedAt: null } }) : 0;
    const chart = ['At Risk', 'Developing Risk', 'Watch', 'On Track'].map((b) => ({ label: b, value: b === 'On Track' ? ids.length - count('At Risk') - count('Developing Risk') - count('Watch') : count(b) }));
    const answer = `Of ${ids.length} students you can see, ${count('At Risk')} are At Risk and ${count('Developing Risk')} are Developing Risk (${count('Watch')} on watch). ${awaiting} signal${awaiting === 1 ? ' is' : 's are'} waiting for a teacher's review.\n\nRisk bands are a working view for staff — never shared with students or parents.`;
    return { topic: 'earlywarning', found: true, answer, confidence: 'High', chart, sources: this.src('Early Warning', 'Risk bands today') };
  }

  // ---------------------------------------------------------------------------
  // Facts for the WhatsApp assistant (approved school records only)
  // ---------------------------------------------------------------------------

  async whatsappFacts(opts: { campusId?: string | null; grade?: number | null; family: boolean }): Promise<string[]> {
    const facts: string[] = [];
    const campuses = await this.prisma.campus.findMany({ where: { isActive: true }, select: { id: true, name: true, place: true, curriculum: true, address: true }, orderBy: { name: 'asc' } });
    for (const c of campuses) facts.push(`Campus: ${c.name} (${c.place})${c.curriculum ? ` — curriculum: ${c.curriculum}` : ''}${c.address ? ` — address: ${c.address}` : ''}`);
    const stages = await this.prisma.curriculumStage.findMany({ orderBy: { sortOrder: 'asc' } });
    for (const s of stages) facts.push(`Curriculum stage: ${s.name} covers Grades ${s.gradeFrom}–${s.gradeTo}`);
    const classes = await this.prisma.schoolClass.findMany({ select: { gradeLevel: true, campus: { select: { name: true } } } });
    const byCampus = new Map<string, number[]>();
    for (const c of classes) byCampus.set(c.campus.name, [...(byCampus.get(c.campus.name) ?? []), c.gradeLevel]);
    for (const [name, gs] of byCampus) facts.push(`Grades offered at ${name}: ${[...new Set(gs)].sort((a, b) => a - b).join(', ')}`);

    const { year, classes: feeClasses, lines } = await this.feeLines(opts.campusId, opts.grade);
    const byClass = new Map<string, typeof lines>();
    for (const l of lines) byClass.set(l.classId, [...(byClass.get(l.classId) ?? []), l]);
    for (const [classId, ls] of [...byClass.entries()].slice(0, 30)) {
      const c = feeClasses.get(classId)!;
      const terms = new Map<string, number>();
      for (const l of ls) terms.set(l.term, (terms.get(l.term) ?? 0) + Number(l.amount));
      facts.push(`Fees ${year ?? ''} ${c.name} at ${c.campus.name}: ${[...terms.entries()].map(([t, v]) => `${t} ${money(v)}`).join(', ')}; heads: ${[...new Set(ls.map((l) => l.feeHead.name))].join(', ')}; total ${money(ls.reduce((n, l) => n + Number(l.amount), 0))}`);
    }
    if (!lines.length) facts.push(`Fees: no approved fee structure${opts.grade ? ` for Grade ${opts.grade}` : ''} is recorded — do not quote any amount; offer to have the admissions team share it.`);

    const routes = await this.prisma.transportRoute.findMany({ where: { isActive: true, ...(opts.campusId ? { campusId: opts.campusId } : {}) }, select: { id: true, name: true, campusId: true } });
    const areas = new Map((await this.prisma.transportRouteProfile.findMany({ where: { routeId: { in: routes.map((r) => r.id) } }, select: { routeId: true, area: true } })).map((p) => [p.routeId, p.area]));
    const campusName = new Map(campuses.map((c) => [c.id, c.name]));
    if (routes.length) facts.push(`School bus areas served: ${routes.map((r) => `${areas.get(r.id) || r.name} (${campusName.get(r.campusId) ?? ''})`).join('; ')}`);

    const periods = await this.prisma.timetablePeriod.findMany({ orderBy: { periodNo: 'asc' }, select: { campusId: true, startsAt: true, endsAt: true } });
    const perCampus = new Map<string, { start: string; end: string }>();
    for (const p of periods) {
      const cur = perCampus.get(p.campusId);
      perCampus.set(p.campusId, { start: cur && cur.start < p.startsAt ? cur.start : p.startsAt, end: cur && cur.end > p.endsAt ? cur.end : p.endsAt });
    }
    for (const c of campuses) {
      const t = perCampus.get(c.id);
      if (t) facts.push(`School day at ${c.name}: lessons ${t.start} to ${t.end}`);
    }

    const events = await this.upcomingEvents(opts.campusId, true, opts.family ? 6 : 3);
    for (const e of events) {
      if (!opts.family && !/admission|open (day|house)|orientation|holiday|annual/i.test(`${e.title} ${e.eventType}`)) continue;
      facts.push(`Event: ${e.title} on ${longDate(e.startsOn)}${e.startsAt ? ` at ${e.startsAt}` : ''}${e.venue ? `, ${e.venue}` : ''}`);
    }
    if (opts.family) {
      const { sessions, sections, event } = await this.nextPtm(opts.campusId, opts.grade);
      if (sessions[0]) {
        const sec = sections.get(sessions[0].sectionId);
        facts.push(`Next PTM${opts.grade ? ` for Grade ${opts.grade}` : ''}: ${longDate(sessions[0].sessionDate)} from ${sessions[0].startsAt}${sec ? ` (${sec.class.name}${sec.name})` : ''}`);
      } else if (event) facts.push(`Next PTM: ${longDate(event.startsOn)}${event.startsAt ? ` at ${event.startsAt}` : ''}`);
    }
    return facts;
  }
}
