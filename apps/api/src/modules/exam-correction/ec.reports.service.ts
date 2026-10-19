import { Injectable, StreamableFile } from '@nestjs/common';
import type { ExamCorrectionExam } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { badRequest, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AssessmentsService } from '../academics/assessments.service';
import { EcAudit } from './ec.audit';
import { csvLine, r2, r6 } from './ec.util';
import { EcViews, jObj, totals } from './ec.views.service';

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (n: number | null, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Results & reports of an examination, the CSV export, and sending approved marks to an Academics assessment. */
@Injectable()
export class EcReports {
  constructor(
    private readonly prisma: PrismaService,
    private readonly views: EcViews,
    private readonly assessments: AssessmentsService,
    private readonly audit: EcAudit,
  ) {}

  /** Every sheet with its student, totals and whether every mark is approved. */
  private async sheets(exam: ExamCorrectionExam) {
    const [{ qs }, subs] = await Promise.all([
      this.views.questions(exam.id),
      this.prisma.examCorrectionSubmission.findMany({ where: { examId: exam.id }, orderBy: { createdAt: 'asc' } }),
    ]);
    const [students, answers] = await Promise.all([
      this.prisma.student.findMany({ where: { id: { in: subs.map((s) => s.studentId) } }, select: { id: true, fullName: true, admissionNo: true, rollNo: true } }),
      subs.length ? this.prisma.examCorrectionAnswer.findMany({ where: { submissionId: { in: subs.map((s) => s.id) } } }) : Promise.resolve([]),
    ]);
    const rows = subs.map((s) => {
      const st = students.find((x) => x.id === s.studentId);
      const mine = answers.filter((a) => a.submissionId === s.id);
      const t = totals(qs, mine);
      return { sub: s, student: st, answers: mine, totals: t, approved: t.approved && s.identityVerified };
    }).sort((a, b) => (a.student?.rollNo ?? 9999) - (b.student?.rollNo ?? 9999) || (a.student?.fullName ?? '').localeCompare(b.student?.fullName ?? ''));
    return { qs, rows, answers };
  }

  async report(exam: ExamCorrectionExam) {
    const { qs, rows, answers } = await this.sheets(exam);
    const maximum = r6(qs.reduce((t, q) => t + q.maxMarks, 0));
    const answerIds = answers.map((a) => a.id);
    const [latest, evalCost, readings, overrideEvents] = await Promise.all([
      answerIds.length ? this.prisma.examCorrectionEvaluation.findMany({ where: { answerId: { in: answerIds } }, orderBy: { createdAt: 'desc' }, distinct: ['answerId'] }) : Promise.resolve([]),
      this.prisma.examCorrectionEvaluation.aggregate({ where: { answer: { submission: { examId: exam.id } } }, _sum: { costUsd: true } }),
      this.prisma.examCorrectionExtraction.findMany({ where: { submission: { examId: exam.id }, status: { in: ['done', 'failed'] } }, select: { status: true, durationMs: true, costUsd: true } }),
      this.prisma.examCorrectionAnswerEvent.findMany({ where: { kind: 'marks', answer: { submission: { examId: exam.id } } }, select: { marksBefore: true, marksAfter: true } }),
    ]);
    const approvedTotals = rows.filter((r) => r.approved).map((r) => r.totals.total);
    const ok = latest.filter((e) => e.status === 'ok');
    const rank = (key: 'misconceptions' | 'missing_concepts'): [string, number][] => {
      const counts = new Map<string, { label: string; n: number }>();
      for (const e of ok) {
        const list = jObj<Record<string, unknown>>(e.result)[key];
        for (const item of Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []) {
          const k = item.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
          if (!k) continue;
          const c = counts.get(k) ?? { label: item, n: 0 };
          c.n++;
          counts.set(k, c);
        }
      }
      return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 8).map((c) => [c.label, c.n]);
    };
    const pairs = answers
      .filter((a) => a.markStatus === 'approved' && a.finalMarks != null)
      .map((a) => ({ teacher: a.finalMarks!, ai: ok.find((e) => e.answerId === a.id)?.suggestedMarks ?? null }))
      .filter((p): p is { teacher: number; ai: number } => p.ai != null);
    const diffs = pairs.map((p) => p.teacher - p.ai);
    const done = readings.filter((r) => r.status === 'done');
    return {
      exam: { maximum, results_status: exam.resultsStatus },
      summary: {
        submissions: rows.length,
        approved_sheets: approvedTotals.length,
        pending_review: answers.filter((a) => a.markStatus !== 'approved').length,
        failed_or_attention: rows.filter((r) => r.sub.status === 'failed' || r.sub.status === 'needs_attention').length,
        class_average: round(mean(approvedTotals)),
        highest: approvedTotals.length ? Math.max(...approvedTotals) : null,
        lowest: approvedTotals.length ? Math.min(...approvedTotals) : null,
      },
      students: rows.map((r) => ({
        submission_id: r.sub.id,
        name: r.student?.fullName ?? 'Unknown student',
        admission_no: r.student?.admissionNo ?? '',
        total: r.totals.total,
        maximum: r.totals.maximum,
        percent: r.totals.maximum > 0 ? r2((100 * r.totals.total) / r.totals.maximum) : null,
        approved: r.approved,
        status: r.sub.status,
      })),
      questions: qs.map((q) => {
        const mine = answers.filter((a) => a.questionId === q.id);
        const marked = mine.filter((a) => a.finalMarks != null).map((a) => a.finalMarks!);
        const avg = mean(marked);
        return {
          number: q.number,
          text: q.text,
          max_marks: q.maxMarks,
          average: round(avg),
          average_percent: avg == null || !q.maxMarks ? null : round((100 * avg) / q.maxMarks),
          full_marks: marked.filter((m) => m >= q.maxMarks - 1e-9).length,
          zero: marked.filter((m) => m === 0).length,
          needs_review: mine.filter((a) => a.markStatus !== 'approved').length,
        };
      }),
      common_misconceptions: rank('misconceptions'),
      common_missing_concepts: rank('missing_concepts'),
      ai_vs_teacher: {
        approved_with_ai_suggestion: pairs.length,
        exact_agreement: diffs.filter((d) => Math.abs(d) < 1e-9).length,
        within_half_mark: diffs.filter((d) => Math.abs(d) <= 0.5 + 1e-9).length,
        mean_absolute_difference: round(mean(diffs.map(Math.abs))),
        teacher_higher: diffs.filter((d) => d > 1e-9).length,
        teacher_lower: diffs.filter((d) => d < -1e-9).length,
      },
      overrides: { count: overrideEvents.filter((e) => e.marksBefore == null || e.marksAfter == null || Math.abs(e.marksBefore - e.marksAfter) > 1e-9).length },
      ocr: { answers: answers.filter((a) => (a.correctedText ?? a.originalText).trim()).length, corrected_by_teacher: answers.filter((a) => a.correctedText != null).length },
      processing: {
        runs: readings.length,
        failed: readings.length - done.length,
        average_seconds: round(mean(done.map((r) => r.durationMs / 1000)), 1),
        cost_usd: round(readings.reduce((t, r) => t + r.costUsd, 0), 4) ?? 0,
      },
      evaluation_cost_usd: round(evalCost._sum.costUsd ?? 0, 4) ?? 0,
    };
  }

  async csv(exam: ExamCorrectionExam): Promise<StreamableFile> {
    const { qs, rows } = await this.sheets(exam);
    const lines = [
      csvLine(['Roll', 'Admission no', 'Student', ...qs.map((q) => `Q${q.number} (${q.maxMarks})`), 'Total', 'Maximum', 'Percent', 'All marks approved', 'Status']),
      ...rows.map((r) => csvLine([
        r.student?.rollNo ?? '', r.student?.admissionNo ?? '', r.student?.fullName ?? 'Unknown student',
        ...qs.map((q) => r.answers.find((a) => a.questionId === q.id)?.finalMarks ?? ''),
        r.totals.total, r.totals.maximum, r.totals.maximum > 0 ? r2((100 * r.totals.total) / r.totals.maximum) : '',
        r.approved ? 'yes' : 'no', r.sub.status,
      ])),
    ];
    const name = `${exam.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'examination'}_results.csv`;
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
    return new StreamableFile(Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
  }

  /** Sends the totals of fully approved sheets into an Academics assessment (scaled to its maximum). */
  async push(user: AuthUser, exam: ExamCorrectionExam, assessmentId: string, req: Request) {
    if (exam.resultsStatus !== 'approved' && exam.resultsStatus !== 'published') throw badRequest('Approve the results first (button at the top of the examination).');
    const assessment = await this.prisma.assessment.findUnique({ where: { id: assessmentId } });
    if (!assessment) throw notFound('Assessment');
    const { rows } = await this.sheets(exam);
    const maximum = rows[0]?.totals.maximum ?? 0;
    if (!(maximum > 0)) throw badRequest('This examination has no questions with marks.');
    const roster = new Set((await this.assessments.roster(assessment)).map((s) => s.id));
    const scaled = Math.abs(assessment.maxMarks - maximum) > 1e-9;
    const skipped: { admissionNo: string; name: string; reason: string }[] = [];
    const marks: { studentId: string; marks: number; isAbsent: boolean }[] = [];
    for (const r of rows) {
      const who = { admissionNo: r.student?.admissionNo ?? '', name: r.student?.fullName ?? 'Unknown student' };
      if (!r.approved) skipped.push({ ...who, reason: r.sub.identityVerified ? 'not every mark is approved yet' : 'the student’s identity is not confirmed' });
      else if (!roster.has(r.sub.studentId)) skipped.push({ ...who, reason: 'not on this assessment’s roster' });
      else marks.push({ studentId: r.sub.studentId, marks: scaled ? r2((r.totals.total * assessment.maxMarks) / maximum) : r.totals.total, isAbsent: false });
    }
    const res = await this.assessments.saveMarks(user, assessment.id, marks, 'save', req);
    if (marks.length) {
      await this.prisma.examCorrectionExam.update({ where: { id: exam.id }, data: { assessmentId: assessment.id, pushedAt: new Date(), pushedByName: user.fullName } });
    }
    await this.audit.record(user, {
      action: 'export', entityType: 'exam', entityId: exam.id, campusId: exam.campusId, sensitive: true,
      description: `Sent ${marks.length} approved total(s) of "${exam.name}" to assessment ${assessment.code}${scaled ? ` (scaled from ${maximum} to ${assessment.maxMarks})` : ''}; ${skipped.length} not sent`,
      metadata: { assessmentId: assessment.id, sent: marks.length, skipped: skipped.length },
    }, req);
    return { sent: marks.length, skipped, scaledFrom: scaled ? maximum : null, scaledTo: assessment.maxMarks, entered: res.entered, of: res.of };
  }
}
