import { Injectable } from '@nestjs/common';
import type {
  ExamCorrectionAnswer, ExamCorrectionEvaluation, ExamCorrectionExam, ExamCorrectionExtraction, ExamCorrectionJob, ExamCorrectionQuestion,
  ExamCorrectionRubric, ExamCorrectionSubmission, Prisma,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import type { RubricData } from './ec.prompts';
import { nameCheck, r6, rubricProblems, type Criterion } from './ec.util';

// JSON column readers.
export const jArr = <T = string>(v: Prisma.JsonValue | null | undefined): T[] => (Array.isArray(v) ? (v as unknown as T[]) : []);
export const jObj = <T = Record<string, unknown>>(v: Prisma.JsonValue | null | undefined): T => (v && typeof v === 'object' && !Array.isArray(v) ? (v as unknown as T) : ({} as T));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const BUSY = ['queued', 'running'];
export const REVIEW_STATES = ['suggested', 'needs_review', 'reviewed'];

export function rubricData(r: ExamCorrectionRubric): RubricData {
  return {
    version: r.version, source: r.source, referenceAnswer: r.referenceAnswer, criteria: jArr<Criterion>(r.criteria),
    expectedConcepts: jArr(r.expectedConcepts), alternatives: jArr(r.alternatives), misconceptions: jArr(r.misconceptions),
    partialCreditRules: r.partialCreditRules, requiredElements: r.requiredElements, ignoreCriteria: r.ignoreCriteria, subjectRules: r.subjectRules,
  };
}

export function rubricDto(r: ExamCorrectionRubric) {
  return {
    version: r.version,
    source: r.source as 'teacher' | 'ai_draft',
    reference_answer: r.referenceAnswer,
    criteria: jArr<Criterion>(r.criteria).map((c) => ({ id: c.id, name: c.name, max_marks: Number(c.max_marks), description: c.description ?? '' })),
    expected_concepts: jArr<string>(r.expectedConcepts),
    alternatives: jArr<string>(r.alternatives),
    misconceptions: jArr<string>(r.misconceptions),
    partial_credit_rules: r.partialCreditRules,
    required_elements: r.requiredElements,
    ignore_criteria: r.ignoreCriteria,
    subject_rules: r.subjectRules,
    created_at: r.createdAt.toISOString(),
  };
}

export function questionDto(q: ExamCorrectionQuestion, r: ExamCorrectionRubric | null) {
  return {
    id: q.id,
    number: q.number,
    order: q.order,
    text: q.text,
    qtype: q.qtype,
    max_marks: q.maxMarks,
    mark_increment: q.markIncrement,
    numeric_answer: q.numericAnswer,
    numeric_tolerance: q.numericTolerance,
    unit: q.unit,
    rubric: r ? rubricDto(r) : null,
    rubric_problems: rubricProblems(q, r ? { criteria: jArr<Criterion>(r.criteria), referenceAnswer: r.referenceAnswer, expectedConcepts: jArr(r.expectedConcepts), source: r.source, problems: jArr(r.problems) } : null),
  };
}

export function evaluationDto(e: ExamCorrectionEvaluation) {
  return {
    id: e.id,
    status: e.status,
    provider: e.provider,
    model: e.model,
    rubric_version: e.rubricVersion,
    prompt_version: e.promptVersion,
    suggested_marks: e.suggestedMarks,
    requires_review: e.requiresReview,
    review_reasons: jArr<string>(e.reviewReasons),
    error: e.error,
    created_at: e.createdAt.toISOString(),
    checks: jArr<{ check: string; ok: boolean | null; detail: string }>(e.checks),
    result: (e.result as Record<string, unknown> | null) ?? null,
  };
}

export function answerDto(a: ExamCorrectionAnswer) {
  return {
    id: a.id,
    original_text: a.originalText,
    corrected_text: a.correctedText,
    text: a.correctedText ?? a.originalText,
    ocr_status: a.ocrStatus,
    page_refs: jArr<number>(a.pageRefs),
    flags: jArr<string>(a.flags),
    final_marks: a.finalMarks,
    criterion_marks: jObj<Record<string, number>>(a.criterionMarks),
    mark_status: a.markStatus,
    feedback: a.feedback,
    approved_at: iso(a.approvedAt),
  };
}

export const jobDto = (j: ExamCorrectionJob | null | undefined) => (j ? { id: j.id, kind: j.kind, status: j.status, progress: j.progress, error: j.error } : null);

/** Builds the shapes the Paper Correction pages read. */
@Injectable()
export class EcViews {
  constructor(private readonly prisma: PrismaService) {}

  /** Current (highest-version) rubric of each question. */
  async currentRubrics(questionIds: string[]): Promise<Map<string, ExamCorrectionRubric>> {
    if (!questionIds.length) return new Map();
    const rows = await this.prisma.examCorrectionRubric.findMany({ where: { questionId: { in: questionIds } }, orderBy: { version: 'desc' }, distinct: ['questionId'] });
    return new Map(rows.map((r) => [r.questionId, r]));
  }

  async questions(examId: string) {
    const qs = await this.prisma.examCorrectionQuestion.findMany({ where: { examId }, orderBy: [{ order: 'asc' }, { number: 'asc' }] });
    const rubrics = await this.currentRubrics(qs.map((q) => q.id));
    return { qs, rubrics };
  }

  /** Examination rows with question totals, teachers and sheet counts. */
  async exams(exams: ExamCorrectionExam[], withQuestions = false) {
    const ids = exams.map((e) => e.id);
    if (!ids.length) return [];
    const [questions, teachers, subs, busy, awaiting] = await Promise.all([
      this.prisma.examCorrectionQuestion.groupBy({ by: ['examId'], where: { examId: { in: ids } }, _sum: { maxMarks: true }, _count: { _all: true } }),
      this.prisma.examCorrectionTeacher.findMany({ where: { examId: { in: ids } }, orderBy: { assignedAt: 'asc' } }),
      this.prisma.examCorrectionSubmission.findMany({ where: { examId: { in: ids } }, select: { id: true, examId: true, status: true } }),
      this.prisma.examCorrectionJob.findMany({ where: { status: { in: BUSY }, submission: { examId: { in: ids } } }, select: { submissionId: true }, distinct: ['submissionId'] }),
      this.prisma.examCorrectionAnswer.findMany({ where: { markStatus: { in: REVIEW_STATES }, submission: { examId: { in: ids } } }, select: { submissionId: true }, distinct: ['submissionId'] }),
    ]);
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(teachers.map((t) => t.userId))] } }, select: { id: true, fullName: true } });
    const userName = new Map(users.map((u) => [u.id, u.fullName]));
    const busySet = new Set(busy.map((b) => b.submissionId));
    const awaitSet = new Set(awaiting.map((a) => a.submissionId));
    const out = [];
    for (const e of exams) {
      const q = questions.find((x) => x.examId === e.id);
      const mine = subs.filter((s) => s.examId === e.id);
      const base = {
        id: e.id,
        name: e.name,
        academic_year: e.academicYear,
        class_name: e.className,
        section: e.section,
        subject: e.subject,
        grade_level: e.gradeLevel,
        instructions: e.instructions,
        results_status: e.resultsStatus as 'draft' | 'reviewed' | 'approved' | 'published',
        maximum: r6(q?._sum.maxMarks ?? 0),
        question_count: q?._count._all ?? 0,
        teachers: teachers.filter((t) => t.examId === e.id).map((t) => ({ id: t.userId, name: userName.get(t.userId) ?? 'Former user' })),
        counts: {
          submissions: mine.length,
          processing: mine.filter((s) => busySet.has(s.id)).length,
          pending_review: mine.filter((s) => awaitSet.has(s.id)).length,
          approved: mine.filter((s) => s.status === 'approved').length,
          failed: mine.filter((s) => s.status === 'failed' || s.status === 'needs_attention').length,
        },
      };
      if (withQuestions) {
        const { qs, rubrics } = await this.questions(e.id);
        out.push({ ...base, questions: qs.map((x) => questionDto(x, rubrics.get(x.id) ?? null)) });
      } else out.push(base);
    }
    return out;
  }

  async exam(e: ExamCorrectionExam) {
    return (await this.exams([e], true))[0];
  }

  /** Answer-sheet rows (the roster table on the examination page). */
  async sheetRows(subs: ExamCorrectionSubmission[], exam: ExamCorrectionExam) {
    if (!subs.length) return [];
    const ids = subs.map((s) => s.id);
    const [students, pageCounts, answers, questions, jobs, readings] = await Promise.all([
      this.prisma.student.findMany({ where: { id: { in: subs.map((s) => s.studentId) } }, select: { id: true, fullName: true, admissionNo: true, rollNo: true } }),
      this.prisma.examCorrectionPage.groupBy({ by: ['submissionId'], where: { submissionId: { in: ids } }, _count: { _all: true } }),
      this.prisma.examCorrectionAnswer.findMany({ where: { submissionId: { in: ids } }, select: { submissionId: true, questionId: true, finalMarks: true, markStatus: true } }),
      this.prisma.examCorrectionQuestion.findMany({ where: { examId: exam.id }, select: { id: true, maxMarks: true } }),
      this.prisma.examCorrectionJob.findMany({ where: { submissionId: { in: ids } }, orderBy: { createdAt: 'desc' }, distinct: ['submissionId'] }),
      this.prisma.examCorrectionExtraction.findMany({ where: { submissionId: { in: ids }, active: true }, select: { submissionId: true, nameOnSheet: true, redacted: true } }),
    ]);
    const student = new Map(students.map((s) => [s.id, s]));
    return subs.map((s) => {
      const st = student.get(s.studentId);
      const reading = readings.find((r) => r.submissionId === s.id);
      return {
        id: s.id,
        student: { id: s.studentId, name: st?.fullName ?? 'Unknown student', admission_no: st?.admissionNo ?? '', roll_no: st?.rollNo != null ? String(st.rollNo) : '' },
        status: s.status,
        status_note: s.statusNote,
        pages: pageCounts.find((p) => p.submissionId === s.id)?._count._all ?? 0,
        identity_verified: s.identityVerified,
        filename: s.filename,
        created_at: s.createdAt.toISOString(),
        totals: totals(questions, answers.filter((a) => a.submissionId === s.id)),
        cost: { cost_usd: Math.round(s.costUsd * 10000) / 10000, input_tokens: s.inputTokens, output_tokens: s.outputTokens },
        name_check: reading ? nameCheck(reading.nameOnSheet, st?.fullName ?? '', reading.redacted) : null,
        job: jobDto(jobs.find((j) => j.submissionId === s.id)),
      };
    });
  }

  /** The full review screen of one sheet. */
  async sheet(sub: ExamCorrectionSubmission, exam: ExamCorrectionExam) {
    const [row] = await this.sheetRows([sub], exam);
    const [student, pages, extractions, answers, { qs, rubrics }] = await Promise.all([
      this.prisma.student.findUnique({ where: { id: sub.studentId }, include: { section: true } }),
      this.prisma.examCorrectionPage.findMany({ where: { submissionId: sub.id }, orderBy: { pageNo: 'asc' } }),
      this.prisma.examCorrectionExtraction.findMany({ where: { submissionId: sub.id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.examCorrectionAnswer.findMany({ where: { submissionId: sub.id } }),
      this.questions(exam.id),
    ]);
    const evals = answers.length
      ? await this.prisma.examCorrectionEvaluation.findMany({ where: { answerId: { in: answers.map((a) => a.id) } }, orderBy: { createdAt: 'desc' }, distinct: ['answerId'] })
      : [];
    const active = extractions.find((e) => e.active) ?? null;
    return {
      ...row,
      exam: { id: exam.id, name: exam.name, subject: exam.subject, class_name: exam.className, results_status: exam.resultsStatus },
      student_full: {
        name: student?.fullName ?? row.student.name,
        admission_no: student?.admissionNo ?? row.student.admission_no,
        class_name: exam.className,
        section: student?.section?.name ?? '',
        roll_no: row.student.roll_no,
      },
      page_list: pages.map((p) => {
        const w = jObj<{ warnings?: unknown }>(p.quality).warnings;
        return { id: p.id, page_no: p.pageNo, quality: { warnings: Array.isArray(w) ? (w as string[]) : [] } };
      }),
      active_extraction: active ? extractionDto(active) : null,
      extractions: extractions.map((e) => ({ id: e.id, model: e.model, status: e.status, error: e.error, created_at: e.createdAt.toISOString(), active: e.active })),
      questions: qs.map((q) => {
        const r = rubrics.get(q.id) ?? null;
        const a = answers.find((x) => x.questionId === q.id) ?? null;
        const ev = a ? evals.find((x) => x.answerId === a.id) ?? null : null;
        return {
          question: { id: q.id, number: q.number, text: q.text, qtype: q.qtype, max_marks: q.maxMarks, mark_increment: q.markIncrement, unit: q.unit, rubric: r ? rubricDto(r) : null },
          answer: a ? answerDto(a) : null,
          evaluation: ev ? evaluationDto(ev) : null,
        };
      }),
    };
  }
}

function extractionDto(e: ExamCorrectionExtraction) {
  return {
    id: e.id,
    model: e.model,
    pages: jArr<{ page_no: number; text: string; warnings: string[]; uncertain: string[]; confidence: number | null }>(e.pages),
    warnings: jArr<string>(e.warnings),
    redacted: e.redacted,
    name_on_sheet: e.nameOnSheet,
    unassigned_text: e.unassignedText,
    duration_ms: e.durationMs,
  };
}

/** Marks so far for a sheet: total, maximum, how many questions are marked, and whether all are approved. */
export function totals(questions: { id: string; maxMarks: number }[], answers: { questionId: string; finalMarks: number | null; markStatus: string }[]) {
  const qids = new Set(questions.map((q) => q.id));
  const mine = answers.filter((a) => qids.has(a.questionId));
  return {
    total: r6(mine.reduce((t, a) => t + (a.finalMarks ?? 0), 0)),
    maximum: r6(questions.reduce((t, q) => t + q.maxMarks, 0)),
    marked: mine.filter((a) => a.finalMarks != null).length,
    questions: questions.length,
    approved: questions.length > 0 && questions.every((q) => mine.some((a) => a.questionId === q.id && a.markStatus === 'approved')),
  };
}
