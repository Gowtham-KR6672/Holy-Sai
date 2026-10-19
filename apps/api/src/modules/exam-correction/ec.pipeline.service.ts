import { Injectable } from '@nestjs/common';
import type { ExamCorrectionAnswer, ExamCorrectionConfig, ExamCorrectionExam, ExamCorrectionJob, ExamCorrectionPage, ExamCorrectionQuestion, Prisma } from '@prisma/client';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import type { AiPart } from '../ai/ai.providers';
import { EcAccess, type AiState } from './ec.access';
import { EcAi, type Usage } from './ec.ai.service';
import { EcPages, PermanentError } from './ec.pages.service';
import { lastQuestionOf, MARK_PROMPT_VERSION, mergeReadings, parseReading, READING_SYSTEM, readingIntro, type ChunkReading } from './ec.prompts';
import { effortOf, FLAG_REREAD, FLAG_TEXT_CHANGED, isTeacherFlag, mapLimit, nameCheck, outputCap, sheetStatus } from './ec.util';
import { EcViews, jArr, jObj, rubricData } from './ec.views.service';

type Progress = (text: string) => Promise<void>;

/**
 * The processing pipeline of one answer sheet:
 *   read   — pages (PDF pages or images, rotated, optionally blanked) → AI transcription split by question
 *   mark   — each answer against the current rubric → AI suggestion, checked by code, flagged for review
 *   refresh — the sheet's status for the pages
 */
@Injectable()
export class EcPipeline {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: EcAccess,
    private readonly ai: EcAi,
    private readonly pages: EcPages,
    private readonly views: EcViews,
  ) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async read(job: ExamCorrectionJob, progress: Progress): Promise<void> {
    const sub = await this.prisma.examCorrectionSubmission.findUnique({ where: { id: job.submissionId }, include: { exam: true, pages: { orderBy: { pageNo: 'asc' } } } });
    if (!sub) throw new PermanentError('The answer sheet was removed.');
    const state = await this.access.aiState();
    if (!state.status.reading_available || !state.provider) throw new PermanentError(state.status.reading_reason);
    if (!sub.pages.length) throw new PermanentError('This answer sheet has no pages.');
    const { cfg, provider } = state;
    const effort = effortOf(cfg.effort);
    const questions = await this.prisma.examCorrectionQuestion.findMany({ where: { examId: sub.examId }, orderBy: [{ order: 'asc' }, { number: 'asc' }] });
    const numbers = questions.map((q) => q.number);
    const redact = Math.max(0, Math.min(50, cfg.redactTopPercent));

    const extraction = await this.prisma.examCorrectionExtraction.create({
      data: { submissionId: sub.id, status: 'running', provider: provider.provider, model: provider.visionModel || provider.model, redacted: redact > 0, createdById: job.createdById },
    });
    const started = Date.now();
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, model: null as string | null };
    let committed = false;
    try {
      const chunks: ExamCorrectionPage[][] = [];
      for (let i = 0; i < sub.pages.length; i += effort.pagesPerCall) chunks.push(sub.pages.slice(i, i + effort.pagesPerCall));
      const readings: ChunkReading[] = [];
      const sent = new Set<string>();
      let carry: string | null = null;
      // A chunk whose reply is cut off even at the provider's largest reply budget is read in halves.
      const work = [...chunks];
      while (work.length) {
        const chunk = work.shift()!;
        const nos = chunk.map((p) => p.pageNo);
        await progress(sub.pages.length > 1 ? `Reading page${nos.length > 1 ? `s ${nos[0]}–${nos[nos.length - 1]}` : ` ${nos[0]}`} of ${sub.pages.length}` : 'Reading the page');
        const parts: AiPart[] = [{ type: 'text', text: readingIntro({ examName: sub.exam.name, subject: sub.exam.subject, className: sub.exam.className, questions: questions.map((q) => ({ number: q.number, text: q.text, maxMarks: q.maxMarks })), pageNos: nos, totalPages: sub.pages.length, carryQuestion: carry, redactedFirstPage: redact > 0 && nos.includes(1) }) }];
        for (const p of chunk) {
          const { part, sentAs } = await this.pages.aiPart(p, { pdfOk: state.pdfOk, longEdge: effort.longEdge, redact: p.pageNo === 1 ? redact : 0, providerLabel: provider.label });
          sent.add(sentAs);
          parts.push({ type: 'text', text: `Page ${p.pageNo}:` }, part);
        }
        let r;
        try {
          r = await this.ai.json({ system: READING_SYSTEM, messages: [{ role: 'user', content: parts }], maxTokens: outputCap(provider.provider, effort.readTokens) }, { vision: true, temperature: 0, thinkingBudget: 512 }, cfg);
        } catch (err) {
          if (err instanceof AppError && err.code === 'AI_TRUNCATED' && chunk.length > 1) {
            const half = Math.ceil(chunk.length / 2);
            work.unshift(chunk.slice(0, half), chunk.slice(half));
            continue;
          }
          throw err;
        }
        usage.inputTokens += r.inputTokens;
        usage.outputTokens += r.outputTokens;
        usage.costUsd += r.costUsd;
        usage.model = r.model;
        const parsed = r.json ? parseReading(r.json, nos, numbers) : null;
        if (!parsed) throw new AppError(502, 'AI_BAD_REPLY', `The AI reply for page${nos.length > 1 ? 's' : ''} ${nos.join(', ')} was not a usable transcription.`);
        carry = lastQuestionOf(parsed, carry);
        readings.push(parsed);
      }
      const merged = mergeReadings(readings, numbers);
      const done = await this.prisma.$transaction(async (tx) => {
        await tx.examCorrectionExtraction.updateMany({ where: { submissionId: sub.id, active: true }, data: { active: false } });
        return tx.examCorrectionExtraction.update({
          where: { id: extraction.id },
          data: {
            status: 'done', active: true, model: usage.model ?? extraction.model,
            pages: merged.pages as unknown as Prisma.InputJsonValue, answers: merged.answers as unknown as Prisma.InputJsonValue, warnings: merged.warnings,
            nameOnSheet: redact > 0 ? null : merged.nameOnSheet, unassignedText: merged.unassignedText,
            sentAs: sent.size > 1 ? 'mixed' : [...sent][0] ?? '', durationMs: Date.now() - started,
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd,
          },
        });
      });
      committed = true;
      await this.addUsage(sub.id, usage);
      // Page warnings from the reading (kept apart from upload warnings so readings do not pile up).
      for (const p of sub.pages) {
        const reading = merged.pages.find((x) => x.page_no === p.pageNo)?.warnings ?? [];
        const q = jObj<{ upload?: string[] }>(p.quality);
        const upload = Array.isArray(q.upload) ? q.upload : [];
        await this.prisma.examCorrectionPage.update({ where: { id: p.id }, data: { quality: { upload, reading, warnings: [...new Set([...upload, ...reading])].slice(0, 6) } } });
      }
      await this.applyReading(sub.id, done.id, merged.answers, questions);
    } catch (err) {
      if (committed) throw err;
      await this.prisma.examCorrectionExtraction.update({ where: { id: extraction.id }, data: { status: 'failed', error: (err as Error).message.slice(0, 500), durationMs: Date.now() - started, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd } });
      if (usage.costUsd || usage.inputTokens) await this.addUsage(sub.id, usage);
      throw err;
    }
  }

  /**
   * Puts a reading's answers on the sheet. Teacher corrections and approved marks are kept; answers whose
   * text changed lose their AI suggestion so they are marked again.
   */
  async applyReading(submissionId: string, extractionId: string, readings: { question: string; text: string; page_refs: number[]; confidence: number | null; flags: string[] }[], questions: ExamCorrectionQuestion[]) {
    const existing = await this.prisma.examCorrectionAnswer.findMany({ where: { submissionId } });
    for (const q of questions) {
      const r = readings.find((x) => x.question === q.number) ?? { question: q.number, text: '', page_refs: [], confidence: null, flags: ['No answer was found for this question on the sheet.'] };
      const ocrStatus = r.text && ((r.confidence != null && r.confidence < 0.7) || r.flags.some((f) => f.startsWith('Unclear'))) ? 'needs_verification' : 'extracted';
      const a = existing.find((x) => x.questionId === q.id);
      if (!a) {
        await this.prisma.examCorrectionAnswer.create({
          data: { submissionId, questionId: q.id, extractionId, originalText: r.text, pageRefs: r.page_refs, flags: r.flags, ocrStatus, ocrConfidence: r.confidence },
        });
        continue;
      }
      const keepFlags = jArr<string>(a.flags).filter(isTeacherFlag);
      const before = a.correctedText ?? a.originalText;
      const after = a.correctedText ?? r.text;
      const changed = before !== after;
      const data: Prisma.ExamCorrectionAnswerUpdateInput = { originalText: r.text, pageRefs: r.page_refs, ocrConfidence: r.confidence, extractionId };
      if (a.markStatus !== 'approved') {
        data.ocrStatus = a.correctedText != null || (a.ocrStatus === 'verified' && !changed) ? 'verified' : ocrStatus;
        let flags = [...r.flags, ...keepFlags];
        if (changed && (a.markStatus === 'suggested' || a.markStatus === 'needs_review')) {
          data.markStatus = 'pending';
          data.finalMarks = null;
          data.criterionMarks = {};
          flags = flags.filter((f) => f !== FLAG_TEXT_CHANGED);
        } else if (changed && a.markStatus === 'reviewed') flags.push(FLAG_REREAD);
        data.flags = [...new Set(flags)];
      } else {
        data.flags = [...new Set([...r.flags, ...keepFlags])];
      }
      await this.prisma.examCorrectionAnswer.update({ where: { id: a.id }, data });
    }
  }

  // -------------------------------------------------------------------------
  // Marking
  // -------------------------------------------------------------------------

  async mark(job: ExamCorrectionJob, progress: Progress): Promise<void> {
    const sub = await this.prisma.examCorrectionSubmission.findUnique({ where: { id: job.submissionId }, include: { exam: true } });
    if (!sub) throw new PermanentError('The answer sheet was removed.');
    const state = await this.access.aiState();
    if (!state.status.marking_available) throw new PermanentError(state.status.marking_reason);
    const only = jArr<string>(job.answerIds);
    const answers = await this.prisma.examCorrectionAnswer.findMany({ where: { submissionId: sub.id, markStatus: { not: 'approved' }, ...(only.length ? { id: { in: only } } : {}) }, include: { question: true } });
    const targets = answers.filter((a) => only.length || job.force || a.markStatus === 'pending');
    const rubrics = await this.views.currentRubrics([...new Set(targets.map((a) => a.questionId))]);
    const markable = targets.filter((a) => rubrics.has(a.questionId)).sort((a, b) => a.question.order - b.question.order);
    if (!markable.length) {
      await progress(targets.length ? 'Nothing marked — define the rubrics first' : 'Nothing to mark');
      return;
    }
    const pages = await this.prisma.examCorrectionPage.findMany({ where: { submissionId: sub.id }, orderBy: { pageNo: 'asc' } });
    let n = 0;
    await mapLimit(markable, 2, async (a) => {
      n++;
      await progress(`Marking Q${a.question.number} (${n} of ${markable.length})`);
      await this.markOne(a, sub.exam, rubrics.get(a.questionId)!, pages, state, job.createdById);
    });
  }

  private async markOne(
    a: ExamCorrectionAnswer & { question: ExamCorrectionQuestion },
    exam: ExamCorrectionExam,
    rubric: Parameters<typeof rubricData>[0],
    pages: ExamCorrectionPage[],
    state: AiState,
    by: string | null,
  ) {
    const cfg: ExamCorrectionConfig = state.cfg;
    const effort = effortOf(cfg.effort);
    const q = a.question;
    const text = a.correctedText ?? a.originalText;
    const r = rubricData(rubric);
    try {
      // Diagram answers are marked with their page images as well as the transcription.
      const images: AiPart[] = [];
      if (q.qtype === 'diagram' && text.trim() && state.status.reading_available && state.provider) {
        for (const no of jArr<number>(a.pageRefs).slice(0, 3)) {
          const p = pages.find((x) => x.pageNo === no);
          if (p) images.push((await this.pages.aiPart(p, { pdfOk: state.pdfOk, longEdge: effort.longEdge, redact: p.pageNo === 1 ? cfg.redactTopPercent : 0, providerLabel: state.provider.label })).part);
        }
      }
      const { marked, usage } = await this.ai.mark(
        {
          subject: exam.subject, gradeLevel: exam.gradeLevel, className: exam.className, instructions: exam.instructions,
          question: { number: q.number, text: q.text, qtype: q.qtype, maxMarks: q.maxMarks, markIncrement: q.markIncrement, numericAnswer: q.numericAnswer, unit: q.unit },
          rubric: r, answerText: text, withImages: images.length > 0,
        },
        { numericTolerance: q.numericTolerance, ocrConfidence: a.correctedText != null ? null : a.ocrConfidence, images, maxTokens: effort.markTokens },
        cfg,
      );
      await this.prisma.examCorrectionEvaluation.create({
        data: {
          answerId: a.id, status: marked.valid ? 'ok' : 'invalid', provider: usage.provider, model: usage.model, rubricVersion: r.version, promptVersion: MARK_PROMPT_VERSION,
          suggestedMarks: marked.valid ? marked.total : null, criterionMarks: marked.criterionMarks, requiresReview: marked.requiresReview, reviewReasons: marked.reviewReasons,
          error: marked.error, checks: marked.checks as unknown as Prisma.InputJsonValue, result: marked.result as unknown as Prisma.InputJsonValue,
          confidence: marked.confidence, answerText: text, durationMs: usage.durationMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd, createdById: by,
        },
      });
      if (marked.valid) {
        // Only if nobody approved it in the meantime.
        await this.prisma.examCorrectionAnswer.updateMany({
          where: { id: a.id, markStatus: { not: 'approved' } },
          data: {
            criterionMarks: marked.criterionMarks, finalMarks: marked.total, rubricVersion: r.version,
            markStatus: marked.requiresReview ? 'needs_review' : 'suggested',
            feedback: a.feedback || marked.feedback,
            flags: jArr<string>(a.flags).filter((f) => f !== FLAG_TEXT_CHANGED && f !== FLAG_REREAD),
          },
        });
      }
      await this.addUsage(a.submissionId, usage);
    } catch (err) {
      // No provider / switched off: stop the whole job. Anything else: record it and carry on with the next answer.
      if (err instanceof PermanentError || (err instanceof AppError && err.getStatus() === 503)) throw err;
      await this.prisma.examCorrectionEvaluation.create({
        data: { answerId: a.id, status: 'failed', provider: state.provider?.provider ?? 'unknown', model: state.provider?.model ?? null, rubricVersion: r.version, promptVersion: MARK_PROMPT_VERSION, error: (err as Error).message.slice(0, 500), answerText: text, createdById: by },
      });
    }
  }

  private async addUsage(submissionId: string, u: Pick<Usage, 'inputTokens' | 'outputTokens' | 'costUsd'>) {
    if (!u.inputTokens && !u.outputTokens && !u.costUsd) return;
    await this.prisma.examCorrectionSubmission.update({ where: { id: submissionId }, data: { inputTokens: { increment: u.inputTokens }, outputTokens: { increment: u.outputTokens }, costUsd: { increment: u.costUsd } } });
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** Recomputes every sheet of an examination (after questions are added or removed). */
  async refreshExam(examId: string): Promise<void> {
    const subs = await this.prisma.examCorrectionSubmission.findMany({ where: { examId }, select: { id: true } });
    for (const s of subs) await this.refresh(s.id);
  }

  /** Recomputes the sheet's status and note from its job, reading, answers and identity. */
  async refresh(submissionId: string): Promise<void> {
    const sub = await this.prisma.examCorrectionSubmission.findUnique({ where: { id: submissionId } });
    if (!sub) return;
    const [job, reading, answers, questionCount, student] = await Promise.all([
      this.prisma.examCorrectionJob.findFirst({ where: { submissionId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.examCorrectionExtraction.findFirst({ where: { submissionId, active: true }, select: { nameOnSheet: true, redacted: true } }),
      this.prisma.examCorrectionAnswer.findMany({ where: { submissionId }, select: { id: true, markStatus: true, question: { select: { number: true } } } }),
      this.prisma.examCorrectionQuestion.count({ where: { examId: sub.examId } }),
      this.prisma.student.findUnique({ where: { id: sub.studentId }, select: { fullName: true } }),
    ]);
    const open = answers.filter((a) => a.markStatus !== 'approved');
    const lastEvals = open.length
      ? await this.prisma.examCorrectionEvaluation.findMany({ where: { answerId: { in: open.map((a) => a.id) } }, orderBy: { createdAt: 'desc' }, distinct: ['answerId'], select: { answerId: true, status: true } })
      : [];
    const failedMarks = open.filter((a) => a.markStatus === 'pending' && lastEvals.some((e) => e.answerId === a.id && e.status !== 'ok')).map((a) => a.question.number);
    const st = sheetStatus({
      job: job ? { kind: job.kind, status: job.status, error: job.error } : null,
      hasReading: !!reading,
      questionCount,
      answers,
      identityVerified: sub.identityVerified,
      nameStatus: reading ? nameCheck(reading.nameOnSheet, student?.fullName ?? '', reading.redacted).status : null,
      failedMarks,
    });
    if (st.status !== sub.status || st.note !== sub.statusNote) {
      await this.prisma.examCorrectionSubmission.update({ where: { id: submissionId }, data: { status: st.status, statusNote: st.note.slice(0, 500) } });
    }
  }
}
