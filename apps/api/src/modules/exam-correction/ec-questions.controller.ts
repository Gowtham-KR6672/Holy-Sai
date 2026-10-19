import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { ExamCorrectionExam, ExamCorrectionQuestion, ExamCorrectionRubric } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { badRequest, fieldError, unavailable } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import type { UploadedFileLike } from '../operations/storage.service';
import { EcAccess } from './ec.access';
import { EcAi } from './ec.ai.service';
import { EcAudit } from './ec.audit';
import { DraftAllDto, ImportFieldsDto, QuestionDto, RubricDto } from './ec.dto';
import { EcPages, MAX_FILE_MB } from './ec.pages.service';
import { EcPipeline } from './ec.pipeline.service';
import { RUBRIC_PROMPT_VERSION, type DraftedRubric } from './ec.prompts';
import { effortOf, isStep, mapLimit, outputCap, questionOrder, r6, visionProblem } from './ec.util';
import { EcViews, questionDto, rubricDto } from './ec.views.service';

const MAX_PAPER_PAGES = 10;

/** Questions, model answers and rubrics (teacher-written or AI-drafted), and question-paper import. */
@Controller('exam-correction/api')
@RequirePermissions('assessments.manage')
export class EcQuestionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: EcAccess,
    private readonly views: EcViews,
    private readonly ai: EcAi,
    private readonly pages: EcPages,
    private readonly pipeline: EcPipeline,
    private readonly audit: EcAudit,
  ) {}

  private validate(dto: QuestionDto) {
    if (!isStep(dto.max_marks, dto.mark_increment)) throw fieldError('max_marks', `Must be a multiple of ${dto.mark_increment}`);
    const numeric = dto.numeric_answer?.trim() || null;
    if (numeric && !Number.isFinite(Number(numeric))) throw fieldError('numeric_answer', 'Enter a number');
    return {
      number: dto.number.trim().toLowerCase(),
      text: dto.text.trim(),
      qtype: dto.qtype,
      maxMarks: dto.max_marks,
      markIncrement: dto.mark_increment,
      numericAnswer: numeric,
      numericTolerance: dto.numeric_tolerance ?? 0.01,
      unit: dto.unit?.trim() || null,
    };
  }

  @Post('exams/:id/questions')
  async create(@Param('id', ParseUUIDPipe) id: string, @Body() dto: QuestionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const exam = await this.access.exam(user, id);
    this.access.assertOpen(exam, 'questions');
    const data = this.validate(dto);
    if (await this.prisma.examCorrectionQuestion.count({ where: { examId: id, number: data.number } })) throw fieldError('number', `Q${data.number} already exists`);
    const q = await this.prisma.examCorrectionQuestion.create({ data: { ...data, examId: id, order: questionOrder(data.number) } });
    await this.audit.record(user, { action: 'create', entityType: 'exam_question', entityId: q.id, campusId: exam.campusId, description: `Added Q${q.number} (${q.maxMarks} marks) to "${exam.name}"` }, req);
    await this.pipeline.refreshExam(exam.id);
    return ok(questionDto(q, null), 'Question saved');
  }

  @Put('questions/:id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: QuestionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { question, exam } = await this.access.question(user, id);
    this.access.assertOpen(exam, 'questions');
    const data = this.validate(dto);
    if (data.number !== question.number && (await this.prisma.examCorrectionQuestion.count({ where: { examId: exam.id, number: data.number } }))) throw fieldError('number', `Q${data.number} already exists`);
    const q = await this.prisma.examCorrectionQuestion.update({ where: { id }, data: { ...data, order: questionOrder(data.number) } });
    const changes = (['number', 'text', 'qtype', 'maxMarks', 'markIncrement', 'numericAnswer', 'numericTolerance', 'unit'] as const)
      .filter((k) => String(question[k] ?? '') !== String(q[k] ?? ''))
      .map((k) => (k === 'text' ? 'text' : `${k} ${question[k] ?? '—'} → ${q[k] ?? '—'}`));
    await this.audit.record(user, { action: 'update', entityType: 'exam_question', entityId: id, campusId: exam.campusId, description: `Edited Q${q.number} of "${exam.name}"${changes.length ? `: ${changes.join('; ')}` : ''}` }, req);
    const rubric = (await this.views.currentRubrics([id])).get(id) ?? null;
    return ok(questionDto(q, rubric), 'Question saved');
  }

  @Delete('questions/:id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { question, exam } = await this.access.question(user, id);
    this.access.assertOpen(exam, 'questions');
    const answers = await this.prisma.examCorrectionAnswer.findMany({ where: { questionId: id }, select: { submissionId: true, markStatus: true } });
    await this.prisma.examCorrectionQuestion.delete({ where: { id } });
    await this.pipeline.refreshExam(exam.id);
    await this.audit.record(user, {
      action: 'delete', entityType: 'exam_question', entityId: id, campusId: exam.campusId, sensitive: answers.length > 0,
      description: `Deleted Q${question.number} of "${exam.name}" with its rubric and ${answers.length} answer(s) (${answers.filter((a) => a.markStatus === 'approved').length} approved)`,
    }, req);
    return ok(null, 'Question deleted');
  }

  // -------------------------------------------------------------------------
  // Rubrics
  // -------------------------------------------------------------------------

  @Post('questions/:id/rubric')
  @HttpCode(200)
  async saveRubric(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RubricDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { question: q, exam } = await this.access.question(user, id);
    this.access.assertOpen(exam, 'rubrics');
    if (!dto.criteria.length) throw badRequest('Add at least one criterion.');
    const ids = dto.criteria.map((c) => c.id.trim());
    if (new Set(ids.map((x) => x.toUpperCase())).size !== ids.length) throw badRequest('Each criterion needs a different id.');
    if (dto.criteria.some((c) => !(c.max_marks > 0))) throw badRequest('Every criterion needs marks.');
    const total = r6(dto.criteria.reduce((a, c) => a + c.max_marks, 0));
    if (Math.abs(total - q.maxMarks) > 1e-6) throw badRequest(`Criteria add up to ${total}; the question is worth ${q.maxMarks}.`);
    const lines = (xs?: string[]) => (xs ?? []).map((x) => x.trim()).filter(Boolean);
    const current = (await this.views.currentRubrics([id])).get(id);
    const version = (current?.version ?? 0) + 1;
    const r = await this.prisma.examCorrectionRubric.create({
      data: {
        questionId: id, version, source: dto.source ?? 'teacher', referenceAnswer: (dto.reference_answer ?? '').trim(),
        criteria: dto.criteria.map((c) => ({ id: c.id.trim(), name: c.name.trim(), max_marks: c.max_marks, description: (c.description ?? '').trim() })),
        expectedConcepts: lines(dto.expected_concepts), alternatives: lines(dto.alternatives), misconceptions: lines(dto.misconceptions),
        partialCreditRules: (dto.partial_credit_rules ?? '').trim(), requiredElements: (dto.required_elements ?? '').trim(),
        ignoreCriteria: (dto.ignore_criteria ?? '').trim(), subjectRules: (dto.subject_rules ?? '').trim(),
        createdById: user.id, createdByName: user.fullName,
      },
    });
    // Unapproved answers marked with an older rubric version.
    const reeval = await this.prisma.examCorrectionAnswer.count({ where: { questionId: id, markStatus: { notIn: ['approved', 'pending'] }, rubricVersion: { lt: version } } });
    await this.audit.record(user, { action: current ? 'update' : 'create', entityType: 'exam_rubric', entityId: r.id, campusId: exam.campusId, description: `Saved rubric v${version} for Q${q.number} of "${exam.name}" (${r.source === 'ai_draft' ? 'AI draft' : 'teacher'})` }, req);
    return ok({ version, answers_to_reevaluate: reeval }, 'Rubric saved');
  }

  @Get('questions/:id/rubrics')
  async rubricHistory(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    await this.access.question(user, id);
    const rows = await this.prisma.examCorrectionRubric.findMany({ where: { questionId: id }, orderBy: { version: 'desc' } });
    return rows.map(rubricDto);
  }

  private async draft(exam: ExamCorrectionExam, q: ExamCorrectionQuestion, current: ExamCorrectionRubric | null, answerKey: string | null) {
    const state = await this.access.aiState();
    if (!state.provider) throw unavailable(state.status.marking_reason);
    if (!state.cfg.aiEnabled) throw unavailable('AI is switched off in Paper Correction › AI configuration.');
    const { rubric } = await this.ai.draftRubric(
      {
        subject: exam.subject, gradeLevel: exam.gradeLevel, className: exam.className, instructions: exam.instructions,
        question: { number: q.number, text: q.text, qtype: q.qtype, maxMarks: q.maxMarks, markIncrement: q.markIncrement, numericAnswer: q.numericAnswer, unit: q.unit },
        answerKey, teacherReference: current?.referenceAnswer || null,
      },
      effortOf(state.cfg.effort).rubricTokens,
      state.cfg,
    );
    return { rubric, model: state.provider.model };
  }

  private async saveDraft(q: ExamCorrectionQuestion, d: DraftedRubric, model: string, user: AuthUser) {
    const current = (await this.views.currentRubrics([q.id])).get(q.id);
    return this.prisma.examCorrectionRubric.create({
      data: {
        questionId: q.id, version: (current?.version ?? 0) + 1, source: 'ai_draft', referenceAnswer: d.reference_answer, criteria: d.criteria.map((c) => ({ ...c })),
        expectedConcepts: d.expected_concepts, alternatives: d.alternatives, misconceptions: d.misconceptions, partialCreditRules: d.partial_credit_rules,
        requiredElements: d.required_elements, ignoreCriteria: d.ignore_criteria, subjectRules: d.subject_rules, problems: d.problems,
        model: `${model} · ${RUBRIC_PROMPT_VERSION}`, createdById: user.id, createdByName: user.fullName,
      },
    });
  }

  /** An AI draft for the rubric form — not saved. */
  @Post('questions/:id/rubric/draft')
  @HttpCode(200)
  async draftOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const { question: q, exam } = await this.access.question(user, id);
    const current = (await this.views.currentRubrics([id])).get(id) ?? null;
    const { rubric: d } = await this.draft(exam, q, current, null);
    return ok({
      version: (current?.version ?? 0) + 1, source: 'ai_draft', reference_answer: d.reference_answer, criteria: d.criteria, expected_concepts: d.expected_concepts,
      alternatives: d.alternatives, misconceptions: d.misconceptions, partial_credit_rules: d.partial_credit_rules, required_elements: d.required_elements,
      ignore_criteria: d.ignore_criteria, subject_rules: d.subject_rules, created_at: new Date().toISOString(),
    }, 'AI draft ready — check it before saving');
  }

  /** Drafts and saves an "AI draft" rubric for every question without one (or all). */
  @Post('exams/:id/rubrics/draft-all')
  @HttpCode(200)
  async draftAll(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DraftAllDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const exam = await this.access.exam(user, id);
    this.access.assertOpen(exam, 'rubrics');
    const state = await this.access.aiState();
    if (!state.provider) throw unavailable(state.status.marking_reason);
    const { qs, rubrics } = await this.views.questions(id);
    const targets = qs.filter((q) => dto.only_missing === false || !rubrics.has(q.id));
    const saved: { question: string; version: number }[] = [];
    const failed: { question: string; error: string }[] = [];
    await mapLimit(targets, 2, async (q) => {
      try {
        const { rubric, model } = await this.draft(exam, q, rubrics.get(q.id) ?? null, null);
        const r = await this.saveDraft(q, rubric, model, user);
        saved.push({ question: q.number, version: r.version });
      } catch (err) {
        failed.push({ question: q.number, error: (err as Error).message });
      }
    });
    await this.audit.record(user, { action: 'create', entityType: 'exam_rubric', entityId: id, campusId: exam.campusId, description: `AI drafted rubrics for ${saved.length} question(s) of "${exam.name}"${failed.length ? `; ${failed.length} failed` : ''}` }, req);
    return ok({ saved, failed }, `Rubrics drafted for ${saved.length} question(s)`);
  }

  // -------------------------------------------------------------------------
  // Question paper import
  // -------------------------------------------------------------------------

  @Post('exams/:id/questions/import')
  @HttpCode(200)
  @UseInterceptors(FilesInterceptor('files', MAX_PAPER_PAGES, { limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_PAPER_PAGES }, defParamCharset: 'utf8' }))
  async importPaper(@Param('id', ParseUUIDPipe) id: string, @UploadedFiles() files: UploadedFileLike[] | undefined, @Body() dto: ImportFieldsDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const exam = await this.access.exam(user, id);
    this.access.assertOpen(exam, 'questions');
    const state = await this.access.aiState();
    if (!state.provider) throw unavailable(state.status.marking_reason);
    if (!state.cfg.aiEnabled) throw unavailable('AI is switched off in Paper Correction › AI configuration.');
    const vision = visionProblem(state.provider);
    if (vision) throw unavailable(vision);
    const defaultMarks = Math.min(5, Math.max(1, Number(dto.default_marks ?? '1') || 1));
    const draftRubrics = dto.draft_rubrics !== 'false';
    const pages = await this.pages.prepare(files ?? [], MAX_PAPER_PAGES);
    const effort = effortOf(state.cfg.effort);
    const parts = await this.pages.paperParts(pages, { pdfOk: state.pdfOk, longEdge: Math.max(effort.longEdge, 1600), providerLabel: state.provider.label });
    const intro = `Examination: ${exam.name} — ${exam.subject}, ${exam.className}${exam.gradeLevel ? ` (${exam.gradeLevel})` : ''}. ${pages.length} page(s) follow in order.`;
    const { paper } = await this.ai.readPaper(intro, parts, outputCap(state.provider.provider, effort.paperTokens), state.cfg);

    const existing = await this.prisma.examCorrectionQuestion.findMany({ where: { examId: id }, select: { number: true } });
    const have = new Set(existing.map((q) => q.number));
    const created: ExamCorrectionQuestion[] = [];
    const skipped: string[] = [];
    const defaultUsed: string[] = [];
    const keys = new Map<string, string | null>();
    for (const pq of paper.questions) {
      if (have.has(pq.number)) {
        skipped.push(pq.number);
        continue;
      }
      const max = pq.maxMarks ?? defaultMarks;
      if (pq.maxMarks == null) defaultUsed.push(pq.number);
      const inc = isStep(max, 0.5) ? 0.5 : 0.25;
      const q = await this.prisma.examCorrectionQuestion.create({
        data: { examId: id, number: pq.number, order: questionOrder(pq.number), text: pq.text, qtype: pq.qtype, maxMarks: isStep(max, 0.25) ? max : Math.round(max * 4) / 4, markIncrement: inc, numericAnswer: pq.numericAnswer, unit: pq.unit },
      });
      have.add(q.number);
      created.push(q);
      keys.set(q.id, pq.answer);
    }
    const warnings = [...paper.warnings, ...paper.invalid.map((x) => `Could not use the item numbered "${x}" — add it with Add question.`)];
    if (!paper.questions.length) warnings.push('No questions were found on these pages.');

    const rubricSaved: string[] = [];
    const rubricFailed: { question: string; error: string }[] = [];
    if (draftRubrics && created.length) {
      await mapLimit(created, 2, async (q) => {
        try {
          const { rubric, model } = await this.draft(exam, q, null, keys.get(q.id) ?? null);
          await this.saveDraft(q, rubric, model, user);
          rubricSaved.push(q.number);
        } catch (err) {
          rubricFailed.push({ question: q.number, error: (err as Error).message });
        }
      });
    }
    await this.audit.record(user, {
      action: 'create', entityType: 'exam_question', entityId: id, campusId: exam.campusId,
      description: `Imported the question paper of "${exam.name}": ${created.length} question(s) added, ${skipped.length} skipped${draftRubrics ? `, ${rubricSaved.length} AI-draft rubric(s)` : ''}`,
    }, req);
    if (created.length) await this.pipeline.refreshExam(exam.id);
    const byOrder = (a: string, b: string) => questionOrder(a) - questionOrder(b);
    return ok({
      created: created.map((q) => q.number).sort(byOrder),
      skipped: skipped.sort(byOrder),
      answer_key_found: paper.answerKeyFound,
      warnings,
      rubrics: { saved: rubricSaved.sort(byOrder), failed: rubricFailed },
      default_marks_used: defaultUsed.sort(byOrder),
    }, created.length ? `${created.length} question(s) added` : 'No new questions were added');
  }
}
