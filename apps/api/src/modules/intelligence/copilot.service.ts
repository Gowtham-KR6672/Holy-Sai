import { Injectable, Logger } from '@nestjs/common';
import type { CopilotDraft, CurriculumObjective, Prisma, QuestionBankItem } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AiService } from '../ai/ai.service';
import { EarlyWarningService } from './early-warning.service';
import { addDays, asDate, dayKey, isUuid, loadTerms, mean, round1, schoolToday, termOf, truncate, type Term } from './intel.util';
import { terms as tokenize } from './knowledge.service';

export const DRAFT_TYPES = ['lesson', 'worksheet', 'quiz', 'comment', 'message', 'brief'] as const;
export type DraftType = (typeof DRAFT_TYPES)[number];

export const ACTIONS: { id: DraftType; label: string; icon: string; desc: string }[] = [
  { id: 'lesson', label: 'Lesson plan', icon: 'bookOpen', desc: 'Objective, timed plan, activities, differentiation, exit quiz and homework' },
  { id: 'worksheet', label: 'Worksheet', icon: 'fileText', desc: 'Foundation, core and higher sections from the approved question bank' },
  { id: 'quiz', label: 'Quiz', icon: 'checkSquare', desc: 'A marked quiz from approved question-bank items' },
  { id: 'comment', label: 'Report comments', icon: 'edit', desc: 'A comment for every student in a class, from their results and attendance' },
  { id: 'message', label: 'Parent message', icon: 'message', desc: 'A warm, factual note to one family about attendance, homework or progress' },
  { id: 'brief', label: 'Weekly brief', icon: 'activity', desc: 'Highlights, learning gaps and students to watch for one class' },
];
const TYPE_LABEL: Record<DraftType, string> = { lesson: 'Lesson plan', worksheet: 'Worksheet', quiz: 'Quiz', comment: 'Report comments', message: 'Parent message', brief: 'Weekly brief' };
const LEVELS = ['Foundation', 'Core', 'Higher'] as const;
const LANG: Record<string, string> = { ta: 'Tamil', hi: 'Hindi', en: 'English' };

export interface GenerateInput {
  type: DraftType;
  grade: number;
  subjectId: string;
  topic: string;
  sectionId?: string;
  studentId?: string;
  lessonMinutes?: number;
  messagePurpose?: string;
  plannedFor?: string;
}

interface Ctx {
  grade: number;
  subject: { id: string; name: string; code: string };
  topic: string;
  section: { id: string; label: string; campusId: string } | null;
  objective: CurriculumObjective | null;
  objectiveCount: number;
  items: QuestionBankItem[];
  term: Term | null;
  previous: Term | null;
}

const stageNumber = (label: string) => Number(label.match(/\d+/)?.[0] ?? NaN);
const topicMatch = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** AI Teacher Co-Pilot: context, drafts (template or language model) and the approval gate. */
@Injectable()
export class CopilotService {
  private readonly log = new Logger(CopilotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ai: AiService,
    private readonly ew: EarlyWarningService,
  ) {}

  /** School-level staff see every draft on their campus; everyone else their own. */
  schoolLevel(user: AuthUser) {
    return user.scope === 'school' && user.permissions.has('students.read');
  }

  async sections(user: AuthUser) {
    const where: Prisma.SectionWhereInput = this.schoolLevel(user)
      ? (() => {
          const c = this.scope.campus(user);
          return c ? { campusId: c } : {};
        })()
      : { id: { in: await this.scope.teacherSectionIds(user) } };
    const rows = await this.prisma.section.findMany({
      where,
      select: { id: true, name: true, campusId: true, class: { select: { name: true, gradeLevel: true, campus: { select: { shortName: true, name: true } } } } },
    });
    return rows
      .map((s) => ({ id: s.id, gradeLevel: s.class.gradeLevel, label: `${s.class.name}${s.name}`, campus: s.class.campus.shortName || s.class.campus.name, campusId: s.campusId }))
      .sort((a, b) => a.gradeLevel - b.gradeLevel || a.label.localeCompare(b.label));
  }

  private async subjectsFor(user: AuthUser) {
    const all = await this.prisma.subject.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } });
    if (this.schoolLevel(user) || !user.employeeId) return all;
    const taught = await this.prisma.timetableEntry.findMany({ where: { employeeId: user.employeeId, subjectId: { not: null } }, select: { subjectId: true }, distinct: ['subjectId'] });
    const ids = new Set(taught.map((t) => t.subjectId));
    const mine = all.filter((s) => ids.has(s.id));
    return mine.length ? mine : all;
  }

  private async topicsFor(subjectId: string, grade: number): Promise<string[]> {
    const items = await this.prisma.questionBankItem.findMany({ where: { subjectId, status: { not: 'Retired' } }, select: { topic: true, stageLabel: true, status: true } });
    const forGrade = items.filter((i) => stageNumber(i.stageLabel) === grade);
    const rank = new Map<string, number>();
    for (const i of forGrade) rank.set(i.topic, (rank.get(i.topic) ?? 0) + (i.status === 'Approved' ? 2 : 1));
    const topics = [...rank.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
    if (topics.length) return topics.slice(0, 40);
    const objectives = await this.prisma.curriculumObjective.findMany({ where: { subjectId }, select: { description: true, stageLabel: true } });
    return objectives.filter((o) => stageNumber(o.stageLabel) === grade).map((o) => truncate(o.description, 60)).slice(0, 30);
  }

  private async bestObjective(subjectId: string, grade: number, topic: string) {
    const all = await this.prisma.curriculumObjective.findMany({ where: { subjectId } });
    const mine = all.filter((o) => stageNumber(o.stageLabel) === grade || (Number.isNaN(stageNumber(o.stageLabel)) && true));
    const want = new Set(tokenize(topic));
    let best: CurriculumObjective | null = null;
    let bestScore = 0;
    for (const o of mine) {
      const n = tokenize(`${o.description} ${o.code}`).filter((t) => want.has(t)).length;
      if (n > bestScore) {
        best = o;
        bestScore = n;
      }
    }
    return { objective: best, count: all.filter((o) => stageNumber(o.stageLabel) === grade).length };
  }

  private async terms(): Promise<{ term: Term | null; previous: Term | null }> {
    const terms = await loadTerms(this.prisma);
    const today = schoolToday();
    let term = termOf(terms, today);
    if (term) {
      const any = await this.prisma.assessmentMark.count({ where: { marks: { not: null }, assessment: { heldOn: { gte: asDate(term.start), lte: asDate(today) } } } });
      const i = terms.indexOf(term);
      if (!any && i > 0) term = terms[i - 1];
    }
    const i = term ? terms.indexOf(term) : -1;
    return { term, previous: i > 0 ? terms[i - 1] : null };
  }

  /** Per-student subject averages for a set of students in a term (percent of maximum marks). */
  private async subjectScores(studentIds: string[], subjectId: string, from: string, to: string) {
    if (!studentIds.length) return new Map<string, number>();
    const marks = await this.prisma.assessmentMark.findMany({
      where: { studentId: { in: studentIds }, isAbsent: false, marks: { not: null }, assessment: { subjectId, heldOn: { gte: asDate(from), lte: asDate(to) } } },
      select: { studentId: true, marks: true, assessment: { select: { maxMarks: true } } },
    });
    const by = new Map<string, number[]>();
    for (const m of marks) if (m.assessment.maxMarks > 0) by.set(m.studentId, [...(by.get(m.studentId) ?? []), (100 * (m.marks ?? 0)) / m.assessment.maxMarks]);
    return new Map([...by.entries()].map(([id, xs]) => [id, round1(mean(xs)!)]));
  }

  // ---------------------------------------------------------------------------
  // Context
  // ---------------------------------------------------------------------------

  async context(user: AuthUser, q: { grade?: string; subjectId?: string; topic?: string; sectionId?: string }) {
    const [sections, subjects, status] = await Promise.all([this.sections(user), this.subjectsFor(user), this.ai.status('copilot')]);
    const grades = [...new Set(sections.map((s) => s.gradeLevel))].sort((a, b) => a - b);
    const grade = Number(q.grade) || (grades.includes(6) ? 6 : grades[0]);
    const subjectId = q.subjectId && isUuid(q.subjectId) ? q.subjectId : (subjects.find((s) => s.code === 'MAT') ?? subjects[0])?.id;
    const topics = grade && subjectId ? await this.topicsFor(subjectId, grade) : [];
    let banner: unknown = null;
    if (q.grade && subjectId && q.topic?.trim()) {
      const topic = q.topic.trim();
      const { objective, count } = await this.bestObjective(subjectId, grade, topic);
      const questionCount = await this.prisma.questionBankItem.count({ where: { subjectId, status: 'Approved', topic: { equals: topic, mode: 'insensitive' } } })
        .then(async (n) => n || (await this.prisma.questionBankItem.findMany({ where: { subjectId, status: 'Approved' }, select: { topic: true, stageLabel: true } })).filter((i) => stageNumber(i.stageLabel) === grade && i.topic.toLowerCase().includes(topic.toLowerCase())).length);
      const section = q.sectionId ? sections.find((s) => s.id === q.sectionId) : undefined;
      const ids = (await this.prisma.student.findMany({
        where: section ? { sectionId: section.id, status: 'active' } : { status: 'active', sectionId: { in: sections.filter((s) => s.gradeLevel === grade).map((s) => s.id) } },
        select: { id: true },
      })).map((s) => s.id);
      const { term } = await this.terms();
      let stats: unknown = null;
      if (term && ids.length) {
        const scores = await this.subjectScores(ids, subjectId, term.start, term.end);
        const values = [...scores.values()];
        stats = {
          label: section?.label ?? `Grade ${grade}`, term: term.label, average: values.length ? Math.round(mean(values)!) : null,
          below60: values.filter((v) => v < 60).length, students: values.length || ids.length,
        };
      }
      banner = {
        objective: objective ? { code: objective.code, description: objective.description, coverage: objective.coveragePct, mastery: objective.masteryPct } : null,
        objectiveCount: count, questionCount, stats,
      };
    }
    return {
      actions: ACTIONS,
      sections: sections.map(({ campusId: _c, ...s }) => s),
      subjects,
      grades,
      topics,
      lessonLengths: [30, 35, 40, 45, 60, 80],
      banner,
      provider: status.available
        ? { name: status.label ?? status.provider ?? 'AI', kind: 'model', description: `${status.label ?? status.provider} (${status.model}) drafting from school data — every draft is reviewed before use`, envVar: 'Users & Settings › AI Providers' }
        : { name: 'template', kind: 'template', description: 'Template draft generator — deterministic, built from the curriculum, question bank and class data (no language model connected)', envVar: 'Users & Settings › AI Providers' },
    };
  }

  // ---------------------------------------------------------------------------
  // Drafts
  // ---------------------------------------------------------------------------

  async generate(user: AuthUser, input: GenerateInput) {
    if (!DRAFT_TYPES.includes(input.type)) throw fieldError('type', 'Choose what to draft');
    if (!Number.isInteger(input.grade) || input.grade < 1 || input.grade > 12) throw fieldError('grade', 'Choose a grade');
    const subject = isUuid(input.subjectId) ? await this.prisma.subject.findUnique({ where: { id: input.subjectId }, select: { id: true, name: true, code: true } }) : null;
    if (!subject) throw fieldError('subjectId', 'Choose a subject');
    const topic = input.topic.trim();
    if (topic.length < 2) throw fieldError('topic', 'Choose or type a topic');
    if (input.plannedFor && input.plannedFor < schoolToday()) throw fieldError('plannedFor', 'Choose today or a later date');
    const sections = await this.sections(user);
    let section: Ctx['section'] = null;
    if (input.sectionId) {
      const s = sections.find((x) => x.id === input.sectionId);
      if (!s) throw fieldError('sectionId', 'Choose one of your classes');
      section = { id: s.id, label: s.label, campusId: s.campusId };
    }
    if ((input.type === 'comment' || input.type === 'brief') && !section) throw fieldError('sectionId', 'Choose a class section');
    if (input.type === 'message') {
      if (!input.studentId || !isUuid(input.studentId)) throw fieldError('studentId', 'Choose a student');
      await this.scope.assertStudent(user, input.studentId);
    }
    const { objective, count } = await this.bestObjective(subject.id, input.grade, topic);
    const allItems = await this.prisma.questionBankItem.findMany({ where: { subjectId: subject.id, status: 'Approved' }, orderBy: [{ timesUsed: 'asc' }, { createdAt: 'asc' }] });
    const items = allItems.filter((i) => (Number.isNaN(stageNumber(i.stageLabel)) || stageNumber(i.stageLabel) === input.grade) && (topicMatch(i.topic, topic) || i.topic.toLowerCase().includes(topic.toLowerCase()) || topic.toLowerCase().includes(i.topic.toLowerCase())));
    const { term, previous } = await this.terms();
    const ctx: Ctx = { grade: input.grade, subject, topic, section, objective, objectiveCount: count, items, term, previous };

    const built = await this.build(input, ctx, user);
    const status = await this.ai.status(input.type === 'comment' ? 'report_comments' : 'copilot');
    let generator = { provider: 'template', kind: 'template', version: 'Holy Sai templates v1' };
    if (status.available && ['lesson', 'comment', 'message', 'brief'].includes(input.type)) {
      try {
        const improved = await this.improve(input.type, built.output, ctx);
        if (improved) {
          Object.assign(built.output, improved.patch);
          generator = { provider: status.label ?? status.provider ?? 'AI', kind: 'model', version: improved.model };
        }
      } catch (err) {
        built.warnings.push(`The AI provider did not answer (${truncate((err as Error).message, 120)}), so this draft was built from templates.`);
      }
    }
    const output = { ...built.output, title: built.title, sources: built.sources, warnings: built.warnings, generator };
    const campusId = section?.campusId ?? sections.find((s) => s.gradeLevel === input.grade)?.campusId ?? user.campusId ?? null;
    const draft = await this.prisma.copilotDraft.create({
      data: {
        type: input.type, status: 'Draft', title: built.title, classLabel: section?.label ?? `Grade ${input.grade}`, campusId, gradeLevel: input.grade, sectionId: section?.id ?? null,
        subjectId: subject.id, studentId: input.studentId ?? null, objectiveId: objective?.id ?? null,
        prompt: { ...input, subject: subject.name, sectionLabel: section?.label ?? null } as Prisma.InputJsonValue,
        output: output as Prisma.InputJsonValue, warnings: built.warnings.length, generatorKind: generator.kind,
        requestedById: user.id, requestedByName: user.fullName,
      },
    });
    if (items.length && (input.type === 'quiz' || input.type === 'worksheet' || input.type === 'lesson')) {
      const used = (built.usedItemIds ?? []).filter(Boolean);
      if (used.length) await this.prisma.questionBankItem.updateMany({ where: { id: { in: used } }, data: { timesUsed: { increment: 1 } } });
    }
    return draft;
  }

  private async build(input: GenerateInput, c: Ctx, user: AuthUser): Promise<{ title: string; output: Record<string, unknown>; sources: { label: string; detail: string }[]; warnings: string[]; usedItemIds?: string[] }> {
    const sources: { label: string; detail: string }[] = [];
    const warnings: string[] = [];
    const cls = c.section?.label ?? `Grade ${c.grade}`;
    if (c.objective) sources.push({ label: `Learning objective ${c.objective.code}`, detail: `${c.objective.stageLabel} · coverage ${c.objective.coveragePct}% · mastery ${c.objective.masteryPct}%` });
    else if (['lesson', 'worksheet', 'quiz'].includes(input.type)) warnings.push('No approved learning objective matches this topic — check the objective before approving.');
    const byLevel = (lvl: string) => c.items.filter((i) => i.difficulty === lvl);
    const q = (i: QuestionBankItem) => ({ q: i.question, marks: i.marks, difficulty: i.difficulty, id: i.id });
    if (['lesson', 'worksheet', 'quiz'].includes(input.type)) {
      sources.push({ label: 'Approved question bank', detail: `${c.items.length} item${c.items.length === 1 ? '' : 's'} on “${c.topic}” for Grade ${c.grade}` });
      if (c.items.length < 4) warnings.push(`Only ${c.items.length} approved question-bank item${c.items.length === 1 ? '' : 's'} on this topic — add more under Question Bank for fuller drafts.`);
    }
    const objectiveText = c.objective?.description ?? `Pupils explain and apply ${c.topic.toLowerCase()} in ${c.subject.name}, using the correct vocabulary and showing their method.`;

    if (input.type === 'lesson') {
      const m = Math.min(90, Math.max(20, input.lessonMinutes ?? 40));
      const split = [0.12, 0.25, 0.25, 0.23, 0.15];
      const names = ['Starter', 'Teach', 'Guided practice', 'Independent practice', 'Plenary and exit quiz'];
      let t = 0;
      const exit = c.items.slice(0, 4);
      const plan = names.map((step, i) => {
        const len = i === names.length - 1 ? m - t : Math.max(3, Math.round(m * split[i]));
        const row = { time: `${t}–${t + len} min`, step, detail: '' };
        t += len;
        row.detail = [
          `Retrieval: three quick questions on what pupils already know about ${c.topic.toLowerCase()}; share the objective.`,
          `Model ${c.topic.toLowerCase()} step by step with a worked example; check understanding with mini whiteboards.`,
          `Pairs work through ${byLevel('Core')[0] ? `“${truncate(byLevel('Core')[0].question, 80)}”` : 'two worked examples'} with prompts; circulate and address misconceptions.`,
          'Pupils complete the differentiated exercises at their level; early finishers move to the higher task.',
          `Exit quiz (${exit.length || 'two'} questions) and a one-line reflection: what is one thing you can now do?`,
        ][i];
        return row;
      });
      const differentiated = LEVELS.map((level) => ({
        level,
        detail: byLevel(level)[0]?.question ?? (level === 'Foundation' ? `Complete guided examples of ${c.topic.toLowerCase()} with a step-by-step prompt card.` : level === 'Core' ? `Solve standard ${c.topic.toLowerCase()} questions and explain one method in words.` : `Apply ${c.topic.toLowerCase()} to an unfamiliar problem and justify the approach.`),
      }));
      const hw = byLevel('Core')[1] ?? byLevel('Foundation')[1] ?? c.items[exit.length];
      if (input.plannedFor) sources.push({ label: 'Planned for', detail: input.plannedFor });
      const stats = await this.classStats(c);
      if (stats) sources.push(stats.source);
      return {
        title: `Lesson plan — ${c.topic} (${cls} ${c.subject.name})`,
        output: {
          objective: objectiveText, lessonMinutes: m, plan,
          activities: [
            `Think–pair–share: pupils explain ${c.topic.toLowerCase()} to a partner using the key vocabulary.`,
            `Card sort: match examples of ${c.topic.toLowerCase()} to their correct method or answer.`,
            `Mini whiteboards: whole-class check after each worked example.`,
          ],
          differentiated,
          quiz: exit.map(q),
          homework: hw ? `${hw.question} (${hw.marks} mark${hw.marks === 1 ? '' : 's'})` : `Three practice questions on ${c.topic.toLowerCase()} and one sentence explaining the method used.`,
          plannedFor: input.plannedFor ?? null,
        },
        sources, warnings, usedItemIds: [...exit.map((i) => i.id), ...(hw ? [hw.id] : [])],
      };
    }

    if (input.type === 'worksheet') {
      const sections = LEVELS.map((level) => ({
        level,
        instructions: level === 'Foundation' ? 'Start here. Use the worked example to help you.' : level === 'Core' ? 'Show your working for each question.' : 'Challenge: explain your reasoning in full sentences.',
        items: byLevel(level).slice(0, 4).map(q),
      }));
      for (const s of sections) if (!s.items.length) warnings.push(`No approved ${s.level.toLowerCase()} items on this topic.`);
      return {
        title: `Worksheet — ${c.topic} (${cls} ${c.subject.name})`,
        output: { objective: objectiveText, sections },
        sources, warnings, usedItemIds: sections.flatMap((s) => s.items.map((i) => i.id)),
      };
    }

    if (input.type === 'quiz') {
      const pick: QuestionBankItem[] = [];
      for (let i = 0; pick.length < Math.min(10, c.items.length) && i < 10; i++) for (const lvl of LEVELS) if (byLevel(lvl)[i] && pick.length < 10) pick.push(byLevel(lvl)[i]);
      const questions = pick.map(q);
      const totalMarks = questions.reduce((n, x) => n + x.marks, 0);
      if (!questions.length) warnings.push('No approved question-bank items exist for this topic, so the quiz is empty. Add questions under Question Bank first.');
      return {
        title: `Quiz — ${c.topic} (${cls} ${c.subject.name})`,
        output: { totalMarks, durationMinutes: Math.max(10, Math.round(totalMarks * 1.5)), questions },
        sources, warnings, usedItemIds: pick.map((i) => i.id),
      };
    }

    if (input.type === 'comment') {
      const students = await this.prisma.student.findMany({ where: { sectionId: c.section!.id, status: 'active' }, select: { id: true, fullName: true, firstName: true, admissionNo: true, gender: true }, orderBy: [{ rollNo: 'asc' }, { fullName: 'asc' }] });
      const ids = students.map((s) => s.id);
      const now = c.term ? await this.subjectScores(ids, c.subject.id, c.term.start, c.term.end) : new Map<string, number>();
      const before = c.previous ? await this.subjectScores(ids, c.subject.id, c.previous.start, c.previous.end) : new Map<string, number>();
      const states = await this.ew.states(ids);
      if (!now.size) warnings.push(`No ${c.subject.name} results are recorded for ${cls} this term — comments are general.`);
      sources.push({ label: 'Class results', detail: `${c.subject.name} · ${c.term?.label ?? 'no term'} · ${now.size} of ${students.length} students with results` });
      sources.push({ label: 'Attendance', detail: 'This academic year, from the registers' });
      const comments = students.map((s) => {
        const score = now.get(s.id) ?? null;
        const prev = before.get(s.id) ?? null;
        const trend = score != null && prev != null ? Math.round(score - prev) : null;
        const att = states.get(s.id)?.attendancePct ?? null;
        return { studentId: s.id, studentName: s.fullName, admissionNo: s.admissionNo, subjectScore: score == null ? null : Math.round(score), trend, attendance: att, comment: this.comment(s.firstName, s.gender, c, score, trend, att) };
      });
      return { title: `Report comments — ${cls} ${c.subject.name}`, output: { term: c.term?.label ?? null, comments }, sources, warnings };
    }

    if (input.type === 'message') {
      const student = await this.prisma.student.findUniqueOrThrow({
        where: { id: input.studentId! },
        select: { id: true, fullName: true, firstName: true, gender: true, sectionId: true, section: { select: { name: true, class: { select: { name: true } } } }, guardians: { include: { guardian: true }, orderBy: { isPrimary: 'desc' } } },
      });
      const g = student.guardians[0]?.guardian ?? null;
      const purpose = input.messagePurpose ?? 'general';
      const facts = await this.messageFacts(student.id, student.sectionId, c, purpose);
      const he = student.gender === 'F' ? 'she' : student.gender === 'M' ? 'he' : 'they';
      const teacher = user.fullName;
      const first = student.firstName;
      const subjectLine = purpose === 'attendance' ? `${first}'s attendance` : purpose === 'homework' ? `${first}'s homework in ${c.subject.name}` : purpose === 'progress' ? `${first}'s progress in ${c.subject.name}` : `An update about ${first}`;
      const opener = `Dear ${g ? g.fullName.split(' ')[0] : 'Parent'},`;
      const middle = facts.length ? `I wanted to share a quick update. ${facts.slice(0, 3).map((f) => `${f}.`).join(' ')}` : `I wanted to share a quick update on ${first}'s ${c.subject.name} learning, including our current topic, ${c.topic.toLowerCase()}.`;
      const ask = purpose === 'attendance'
        ? `Regular attendance really helps ${first} keep up with new topics. If there is anything making it hard for ${first} to come to school, please let me know — we would like to help.`
        : purpose === 'homework'
          ? `Homework helps ${first} practise what we cover in class. Could you check in with ${first} about this week's tasks? I am happy to suggest ways to make it easier.`
          : purpose === 'progress'
            ? `We are working on ${c.topic.toLowerCase()} now, and a little practice at home would help ${he === 'they' ? 'them' : he === 'she' ? 'her' : 'him'} build confidence.`
            : `Please feel free to reply if you have any questions.`;
      const body = `${opener}\n\n${middle}\n\n${ask}\n\nWarm regards,\n${teacher}\n${c.subject.name} · ${student.section.class.name}${student.section.name} · Holy Sai International School`;
      if (!g) warnings.push('No guardian is linked to this student, so the message has no recipient yet.');
      else if (!g.phone) warnings.push('The guardian has no phone number on file, so WhatsApp delivery is not possible.');
      sources.push({ label: 'Student record', detail: `${student.fullName} · ${student.section.class.name}${student.section.name}` });
      if (facts.length) sources.push({ label: purpose === 'attendance' ? 'Attendance registers' : purpose === 'homework' ? 'Homework submissions' : 'Assessment results', detail: 'Last 30 days' });
      return {
        title: `Parent message — ${student.fullName} (${purpose})`,
        output: {
          recipient: { parentName: g?.fullName ?? null, guardianId: g?.id ?? null, studentName: student.fullName, studentId: student.id, channel: g?.preferredChannel ?? 'whatsapp', phone: g?.phone ?? null },
          subject: subjectLine, body, facts,
          toneCheck: { result: 'Warm and factual', rules: ['States only facts from the school record', 'No labels and no comparison with other children', 'Invites the family into a conversation', 'Signed by the teacher who will follow up'] },
          ...(g && g.language && g.language !== 'en' ? { translation: { note: `The family prefers ${LANG[g.language] ?? g.language}. Translate after approval if needed — the approved English text is the record.` } } : {}),
        },
        sources, warnings,
      };
    }

    // brief
    const students = await this.prisma.student.findMany({ where: { sectionId: c.section!.id, status: 'active' }, select: { id: true, fullName: true } });
    const ids = students.map((s) => s.id);
    const today = schoolToday();
    const weekFrom = addDays(today, -6);
    const [att, homework, objectives, signals] = await Promise.all([
      ids.length ? this.prisma.studentAttendance.groupBy({ by: ['status'], where: { studentId: { in: ids }, date: { gte: asDate(weekFrom), lte: asDate(today) } }, _count: { _all: true } }) : Promise.resolve([]),
      this.prisma.homework.findMany({ where: { sectionId: c.section!.id, status: { not: 'Draft' }, dueOn: { gte: asDate(weekFrom), lte: asDate(today) } }, select: { id: true, title: true, _count: { select: { submissions: true } } } }),
      this.prisma.curriculumObjective.findMany({ where: { subjectId: c.subject.id } }),
      ids.length ? this.prisma.earlyWarningSignal.findMany({ where: { studentId: { in: ids }, closedAt: null, OR: [{ decision: null }, { decision: 'accepted' }] }, select: { studentId: true, signal: true } }) : Promise.resolve([]),
    ]);
    const states = await this.ew.states(ids);
    const n = (s: string) => att.find((a) => a.status === s)?._count._all ?? 0;
    const marked = att.reduce((t, a) => t + a._count._all, 0);
    const highlights: string[] = [];
    if (marked) highlights.push(`Attendance this week ${Math.round((100 * (n('present') + n('late'))) / marked)}% (${n('absent')} absence${n('absent') === 1 ? '' : 's'}, ${n('late')} late).`);
    if (homework.length) {
      const due = homework.length * ids.length;
      const got = homework.reduce((t, h) => t + h._count.submissions, 0);
      highlights.push(`${homework.length} homework task${homework.length === 1 ? '' : 's'} due this week; ${due ? Math.round((100 * got) / due) : 0}% handed in.`);
    }
    const stats = await this.classStats(c);
    if (stats?.text) highlights.push(stats.text);
    highlights.push(`Current topic: ${c.topic} (${c.subject.name}).`);
    const gaps = objectives
      .filter((o) => stageNumber(o.stageLabel) === c.grade && o.coveragePct > 0 && o.masteryPct < 60)
      .sort((a, b) => a.masteryPct - b.masteryPct)
      .slice(0, 4)
      .map((o) => ({ code: o.code, description: o.description, coverage: o.coveragePct, mastery: o.masteryPct }));
    const watch = students
      .map((s) => {
        const st = states.get(s.id);
        const sig = signals.find((x) => x.studentId === s.id);
        const reason = sig?.signal ?? (st && (st.band === 'At Risk' || st.band === 'Developing Risk') ? `${st.band}: ${st.indicators.join(', ')}` : null);
        return reason ? { id: s.id, name: s.fullName, reason: truncate(reason, 90) } : null;
      })
      .filter((x): x is { id: string; name: string; reason: string } => !!x)
      .slice(0, 8);
    const nextSteps = [
      ...(gaps[0] ? [`Re-teach ${gaps[0].code} (${truncate(gaps[0].description.toLowerCase(), 60)}) with a short retrieval starter on three days next week.`] : []),
      ...(watch.length ? [`Check in with ${watch.slice(0, 3).map((w) => w.name.split(' ')[0]).join(', ')} and record any context against their signals.`] : []),
      `Plan the next ${c.topic.toLowerCase()} lesson with an exit quiz to measure progress.`,
    ];
    sources.push({ label: 'Registers and homework', detail: `${cls} · ${weekFrom} to ${today}` });
    sources.push({ label: 'Learning objectives', detail: `${objectives.filter((o) => stageNumber(o.stageLabel) === c.grade).length} ${c.subject.name} objectives for Grade ${c.grade}` });
    if (stats) sources.push(stats.source);
    return { title: `Weekly brief — ${cls} ${c.subject.name}`, output: { highlights, gaps, watch, nextSteps }, sources, warnings };
  }

  private comment(first: string, gender: string, c: Ctx, score: number | null, trend: number | null, att: number | null): string {
    const pron = gender === 'F' ? 'she' : gender === 'M' ? 'he' : first;
    const lines: string[] = [];
    if (score == null) lines.push(`${first} is working on ${c.subject.name} this term, including ${c.topic.toLowerCase()}.`);
    else if (score >= 80) lines.push(`${first} has produced excellent work in ${c.subject.name} this term, showing secure understanding and careful reasoning.`);
    else if (score >= 65) lines.push(`${first} has made solid progress in ${c.subject.name} this term and applies key methods with growing confidence.`);
    else if (score >= 50) lines.push(`${first} is developing in ${c.subject.name}; ${pron} understands the core ideas and is building accuracy.`);
    else lines.push(`${first} is finding parts of ${c.subject.name} challenging this term and benefits from step-by-step support.`);
    if (trend != null && trend >= 5) lines.push('Results have improved noticeably since last term.');
    else if (trend != null && trend <= -5) lines.push('Results have dipped since last term, and steady practice will help rebuild confidence.');
    if (att != null && att < 90) lines.push(`More regular attendance would help ${first} keep up with new topics.`);
    lines.push(score != null && score >= 80 ? `Next step: take on extension problems in ${c.topic.toLowerCase()}.` : `Next step: regular practice of ${c.topic.toLowerCase()}, showing each step of working.`);
    return lines.join(' ');
  }

  private async messageFacts(studentId: string, sectionId: string, c: Ctx, purpose: string): Promise<string[]> {
    const today = schoolToday();
    const from = addDays(today, -30);
    const facts: string[] = [];
    if (purpose === 'attendance' || purpose === 'general') {
      const rows = await this.prisma.studentAttendance.findMany({ where: { studentId, date: { gte: asDate(from), lte: asDate(today) } }, select: { date: true, status: true }, orderBy: { date: 'asc' } });
      const absent = rows.filter((r) => r.status === 'absent');
      const late = rows.filter((r) => r.status === 'late');
      if (rows.length) facts.push(`In the last 30 days ${absent.length ? `there were ${absent.length} absence${absent.length === 1 ? '' : 's'} (${absent.slice(0, 5).map((r) => dayKey(r.date)).join(', ')})` : 'there were no absences'}${late.length ? ` and ${late.length} late arrival${late.length === 1 ? '' : 's'}` : ''}`);
    }
    if (purpose === 'homework' || purpose === 'general') {
      const hw = await this.prisma.homework.findMany({ where: { sectionId, subjectId: c.subject.id, status: { not: 'Draft' }, dueOn: { gte: asDate(from), lt: asDate(today) } }, select: { id: true, title: true } });
      if (hw.length) {
        const subs = await this.prisma.homeworkSubmission.findMany({ where: { studentId, homeworkId: { in: hw.map((h) => h.id) } }, select: { homeworkId: true } });
        const missing = hw.filter((h) => !subs.some((s) => s.homeworkId === h.id));
        facts.push(`${hw.length - missing.length} of ${hw.length} ${c.subject.name} homework tasks in the last 30 days were handed in${missing.length ? ` (not yet received: ${missing.slice(0, 3).map((m) => m.title).join(', ')})` : ''}`);
      }
    }
    if (purpose === 'progress' || purpose === 'general') {
      const marks = await this.prisma.assessmentMark.findMany({
        where: { studentId, isAbsent: false, marks: { not: null }, assessment: { subjectId: c.subject.id } },
        select: { marks: true, assessment: { select: { name: true, maxMarks: true, heldOn: true } } },
        orderBy: { assessment: { heldOn: 'desc' } }, take: 2,
      });
      for (const m of marks) facts.push(`${m.assessment.name} (${dayKey(m.assessment.heldOn)}): ${m.marks} out of ${m.assessment.maxMarks}`);
    }
    return facts;
  }

  private async classStats(c: Ctx): Promise<{ text: string; source: { label: string; detail: string } } | null> {
    if (!c.term) return null;
    const where: Prisma.StudentWhereInput = c.section ? { sectionId: c.section.id, status: 'active' } : { status: 'active', section: { class: { gradeLevel: c.grade } } };
    const ids = (await this.prisma.student.findMany({ where, select: { id: true } })).map((s) => s.id);
    const scores = [...(await this.subjectScores(ids, c.subject.id, c.term.start, c.term.end)).values()];
    if (!scores.length) return null;
    const avg = Math.round(mean(scores)!);
    const label = c.section?.label ?? `Grade ${c.grade}`;
    return {
      text: `${label} ${c.subject.name} average this term is ${avg}, with ${scores.filter((s) => s < 60).length} of ${scores.length} students below 60.`,
      source: { label: 'Class results', detail: `${label} · ${c.term.label} · average ${avg}` },
    };
  }

  /** Asks the connected model to improve the prose of a draft, keeping every fact and the shape. */
  private async improve(type: DraftType, output: Record<string, unknown>, c: Ctx): Promise<{ patch: Record<string, unknown>; model: string } | null> {
    const rules =
      'You help teachers at Holy Sai International School (Cambridge curriculum, India). Improve the draft below for a busy teacher. ' +
      'Keep every fact, number, name and date exactly as given; never invent results, attendance, dates or fees. No labels for children ' +
      '(never "weak", "slow", "at risk"). British English. Reply with JSON only, containing just the fields asked for.';
    const facts = { subject: c.subject.name, grade: c.grade, topic: c.topic, objective: c.objective ? `${c.objective.code} ${c.objective.description}` : null, class: c.section?.label ?? null };
    let ask: string;
    let pick: string[];
    if (type === 'lesson') {
      pick = ['objective', 'plan', 'activities', 'differentiated', 'homework'];
      ask = 'Return {"objective","plan":[{"time","step","detail"}],"activities":[3–4 strings],"differentiated":[{"level":"Foundation|Core|Higher","detail"}],"homework"}. Keep the same time slots.';
    } else if (type === 'comment') {
      pick = ['comments'];
      ask = 'Return {"comments":[{"studentId","comment"}]} with one 2–3 sentence comment (35–60 words) per student, specific to their score, trend and attendance. Keep studentId values.';
    } else if (type === 'message') {
      pick = ['subject', 'body'];
      ask = 'Return {"subject","body"}: a warm, brief, factual WhatsApp-friendly message to the parent using only the facts given, signed exactly as in the draft.';
    } else {
      pick = ['highlights', 'nextSteps'];
      ask = 'Return {"highlights":[strings],"nextSteps":[strings]} — concise bullet sentences using only the figures given.';
    }
    const draft = Object.fromEntries(Object.entries(output).filter(([k]) => [...pick, 'facts', 'gaps', 'watch', 'recipient', 'quiz', 'lessonMinutes', 'term'].includes(k)));
    const r = await this.ai.completeJson<Record<string, unknown>>(type === 'comment' ? 'report_comments' : 'copilot', {
      system: rules,
      messages: [{ role: 'user', content: `${ask}\n\nContext: ${JSON.stringify(facts)}\n\nDraft: ${JSON.stringify(draft)}` }],
      maxTokens: type === 'comment' ? 4000 : 1800,
      temperature: 0.4,
    });
    const d = r.data;
    const patch: Record<string, unknown> = {};
    if (type === 'comment') {
      const list = Array.isArray(d.comments) ? (d.comments as { studentId?: string; comment?: string }[]) : [];
      const current = output.comments as { studentId: string; comment: string }[];
      patch.comments = current.map((x) => {
        const better = list.find((y) => y.studentId === x.studentId)?.comment;
        return typeof better === 'string' && better.trim().length > 20 ? { ...x, comment: better.trim() } : x;
      });
    } else {
      for (const k of pick) {
        const v = d[k];
        if (v == null) continue;
        if (typeof output[k] === 'string' && typeof v === 'string' && v.trim()) patch[k] = v.trim();
        else if (Array.isArray(output[k]) && Array.isArray(v) && v.length) patch[k] = v;
      }
    }
    return Object.keys(patch).length ? { patch, model: r.model } : null;
  }

  // ---------------------------------------------------------------------------
  // Shapes and access
  // ---------------------------------------------------------------------------

  view(d: CopilotDraft) {
    return {
      id: d.id, type: d.type as DraftType, status: d.status, prompt: d.prompt, output: d.output, title: d.title, classLabel: d.classLabel,
      createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(), approvedAt: d.approvedAt?.toISOString() ?? null,
      requestedById: d.requestedById, requestedBy: d.requestedByName, approvedBy: d.approvedByName, lessonPlanId: d.lessonPlanId,
    };
  }

  row(d: CopilotDraft) {
    return {
      id: d.id, type: d.type as DraftType, status: d.status, createdAt: d.createdAt.toISOString(), approvedAt: d.approvedAt?.toISOString() ?? null,
      requestedBy: d.requestedByName, approvedBy: d.approvedByName, title: d.title, classLabel: d.classLabel, warnings: d.warnings, typeLabel: TYPE_LABEL[d.type as DraftType],
    };
  }

  listWhere(user: AuthUser): Prisma.CopilotDraftWhereInput {
    if (!this.schoolLevel(user)) return { requestedById: user.id };
    const c = this.scope.campus(user);
    return c ? { OR: [{ campusId: c }, { campusId: null }, { requestedById: user.id }] } : {};
  }

  async find(user: AuthUser, id: string) {
    if (!isUuid(id)) throw notFound('Draft');
    const d = await this.prisma.copilotDraft.findUnique({ where: { id } });
    if (!d) throw notFound('Draft');
    if (d.requestedById !== user.id) {
      if (!this.schoolLevel(user)) throw forbidden('This draft belongs to another teacher');
      const c = this.scope.campus(user);
      if (c && d.campusId && d.campusId !== c) throw forbidden('This draft is outside your campus');
    }
    return d;
  }

  assertOpen(d: CopilotDraft) {
    if (d.status === 'Approved') throw badRequest('This draft has already been approved');
    if (d.status === 'Rejected') throw badRequest('This draft was discarded and cannot be changed');
  }

  /** Creates the approved lesson plan for an approved lesson draft. */
  async publishLesson(d: CopilotDraft, user: AuthUser): Promise<string | null> {
    const o = d.output as Record<string, unknown>;
    let authorId = user.employeeId;
    if (!authorId) authorId = (await this.prisma.user.findUnique({ where: { id: d.requestedById }, select: { employeeId: true } }))?.employeeId ?? null;
    const campusId = d.campusId ?? user.campusId;
    if (!authorId || !campusId || !d.subjectId) return null;
    const plan = await this.prisma.lessonPlan.create({
      data: {
        title: String(o.title ?? d.title).slice(0, 200), status: 'Approved', plannedFor: typeof o.plannedFor === 'string' && o.plannedFor ? asDate(o.plannedFor) : null,
        aiGenerated: true, campusId, sectionId: d.sectionId, subjectId: d.subjectId, objectiveId: d.objectiveId, authorId,
        content: { objective: o.objective ?? '', plan: o.plan ?? [], activities: o.activities ?? [], differentiation: o.differentiated ?? [], homework: o.homework ?? '', quiz: o.quiz ?? [], copilotDraftId: d.id } as Prisma.InputJsonValue,
        submittedAt: new Date(), approvedAt: new Date(), approvedById: user.id, approvedByName: user.fullName, reviewNote: 'Approved from an AI Co-Pilot draft',
      },
    });
    return plan.id;
  }
}
