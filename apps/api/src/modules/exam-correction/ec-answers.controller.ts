import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { badRequest, conflict, unavailable } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EcAccess } from './ec.access';
import { EcAudit } from './ec.audit';
import { MarksDto, ReasonDto, TextDto } from './ec.dto';
import { EcPipeline } from './ec.pipeline.service';
import { EcQueue } from './ec.queue.service';
import { FLAG_REVIEW, FLAG_TEXT_CHANGED, isStep, r6, type Criterion } from './ec.util';
import { answerDto, EcViews, evaluationDto, jArr, jObj } from './ec.views.service';

type Loaded = Awaited<ReturnType<EcAccess['answer']>>;

/** Teacher review of one answer: transcription, marks, approval, re-evaluation and the change history. */
@Controller('exam-correction/api/answers')
@RequirePermissions('assessments.manage')
export class EcAnswersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: EcAccess,
    private readonly views: EcViews,
    private readonly pipeline: EcPipeline,
    private readonly queue: EcQueue,
    private readonly notifications: NotificationsService,
    private readonly audit: EcAudit,
  ) {}

  private async load(user: AuthUser, id: string): Promise<Loaded> {
    const l = await this.access.answer(user, id);
    this.access.assertOpen(l.exam);
    return l;
  }

  private async who(l: Loaded) {
    const s = await this.prisma.student.findUnique({ where: { id: l.sub.studentId }, select: { fullName: true, admissionNo: true } });
    return `Q${l.answer.question.number} of ${s?.fullName ?? 'a student'} (${s?.admissionNo ?? ''}), "${l.exam.name}"`;
  }

  private event(answerId: string, user: AuthUser, e: { kind: string; marksBefore?: number | null; marksAfter?: number | null; before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue; reason?: string }) {
    return this.prisma.examCorrectionAnswerEvent.create({ data: { answerId, byId: user.id, byName: user.fullName, reason: e.reason ?? '', kind: e.kind, marksBefore: e.marksBefore ?? null, marksAfter: e.marksAfter ?? null, before: e.before, after: e.after } });
  }

  private async done(id: string, submissionId: string, message: string) {
    await this.pipeline.refresh(submissionId);
    const a = await this.prisma.examCorrectionAnswer.findUniqueOrThrow({ where: { id } });
    return ok(answerDto(a), message);
  }

  @Patch(':id/text')
  async text(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TextDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const l = await this.load(user, id);
    const a = l.answer;
    if (a.markStatus === 'approved') throw conflict('Reopen the answer before changing it.');
    const before = a.correctedText ?? a.originalText;
    const text = dto.text.replace(/\r\n/g, '\n');
    if (text === before) return this.done(id, a.submissionId, 'No change');
    const marked = a.markStatus === 'suggested' || a.markStatus === 'needs_review';
    const flags = jArr<string>(a.flags);
    await this.prisma.examCorrectionAnswer.update({
      where: { id },
      data: {
        correctedText: text === a.originalText ? null : text,
        ocrStatus: 'verified', verifiedById: user.id, verifiedByName: user.fullName, verifiedAt: new Date(),
        ...(marked ? { markStatus: 'needs_review', flags: [...new Set([...flags, FLAG_TEXT_CHANGED])] } : {}),
      },
    });
    await this.event(id, user, { kind: 'text', marksBefore: a.finalMarks, marksAfter: a.finalMarks, before: { text: before }, after: { text }, reason: 'Transcription corrected' });
    await this.audit.record(user, { action: 'update', entityType: 'exam_answer', entityId: id, campusId: l.exam.campusId, sensitive: true, description: `Corrected the transcription of ${await this.who(l)}` }, req);
    return this.done(id, a.submissionId, 'Transcription saved');
  }

  @Post(':id/verify')
  @HttpCode(200)
  async verify(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const l = await this.load(user, id);
    if (l.answer.ocrStatus !== 'verified') {
      await this.prisma.examCorrectionAnswer.update({ where: { id }, data: { ocrStatus: 'verified', verifiedById: user.id, verifiedByName: user.fullName, verifiedAt: new Date() } });
      await this.event(id, user, { kind: 'verify', marksBefore: l.answer.finalMarks, marksAfter: l.answer.finalMarks, reason: 'Transcription verified' });
      await this.audit.record(user, { action: 'update', entityType: 'exam_answer', entityId: id, campusId: l.exam.campusId, sensitive: true, description: `Verified the transcription of ${await this.who(l)}` }, req);
    }
    return this.done(id, l.answer.submissionId, 'Transcription verified');
  }

  private async criteria(questionId: string): Promise<{ criteria: Criterion[]; version: number }> {
    const r = (await this.views.currentRubrics([questionId])).get(questionId);
    if (!r) throw badRequest('This question has no rubric yet. Define it under Questions & rubrics.');
    return { criteria: jArr<Criterion>(r.criteria), version: r.version };
  }

  @Put(':id/marks')
  async marks(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarksDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const l = await this.load(user, id);
    const a = l.answer;
    const q = a.question;
    if (a.markStatus === 'approved') throw conflict('Reopen the answer before changing its marks.');
    const { criteria, version } = await this.criteria(q.id);
    const entered: Record<string, number> = {};
    for (const c of criteria) {
      const v = Number(dto.criterion_marks?.[c.id]);
      if (dto.criterion_marks?.[c.id] == null || !Number.isFinite(v)) throw badRequest(`Enter marks for ${c.id}.`);
      if (v < 0 || v > Number(c.max_marks) + 1e-9) throw badRequest(`${c.id} takes 0 to ${c.max_marks} marks.`);
      if (!isStep(v, q.markIncrement)) throw badRequest(`${c.id}: marks go in steps of ${q.markIncrement}.`);
      entered[c.id] = r6(v);
    }
    const total = Math.min(q.maxMarks, r6(Object.values(entered).reduce((t, v) => t + v, 0)));
    const before = jObj<Record<string, number>>(a.criterionMarks);
    const marksChanged = a.rubricVersion !== version || a.finalMarks == null || criteria.some((c) => Number(before[c.id]) !== entered[c.id]);
    const feedback = dto.feedback ?? a.feedback;
    const reason = (dto.reason ?? '').trim();
    if (marksChanged) {
      const ai = await this.prisma.examCorrectionEvaluation.findFirst({ where: { answerId: id, status: 'ok' }, orderBy: { createdAt: 'desc' } });
      const aiMarks = ai ? jObj<Record<string, number>>(ai.criterionMarks) : null;
      const differsFromAi = !!ai && ai.rubricVersion === version && criteria.some((c) => Number(aiMarks?.[c.id]) !== entered[c.id]);
      if (differsFromAi && !reason) throw badRequest('Enter the reason for changing the AI suggestion.');
    }
    await this.prisma.examCorrectionAnswer.update({
      where: { id },
      data: { criterionMarks: entered, finalMarks: total, rubricVersion: version, feedback, ...(marksChanged ? { markStatus: 'reviewed' } : {}) },
    });
    if (marksChanged) {
      await this.event(id, user, { kind: 'marks', marksBefore: a.finalMarks, marksAfter: total, before: { criterion_marks: before }, after: { criterion_marks: entered }, reason: reason || 'Marks entered by the teacher' });
    }
    await this.audit.record(user, {
      action: 'update', entityType: 'exam_answer', entityId: id, campusId: l.exam.campusId, sensitive: true,
      description: marksChanged
        ? `Marks for ${await this.who(l)}: ${a.finalMarks ?? '—'} → ${total}${reason ? ` (${reason})` : ''}`
        : `Updated the feedback on ${await this.who(l)}`,
      metadata: { before, after: entered, reason },
    }, req);
    return this.done(id, a.submissionId, 'Marks saved');
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const l = await this.load(user, id);
    const a = l.answer;
    if (a.markStatus === 'approved') return this.done(id, a.submissionId, 'Already approved');
    if (!l.sub.identityVerified) throw badRequest('Confirm the student first.');
    const { criteria, version } = await this.criteria(a.questionId);
    const cm = jObj<Record<string, number>>(a.criterionMarks);
    if (criteria.some((c) => typeof cm[c.id] !== 'number' || cm[c.id] < 0 || cm[c.id] > Number(c.max_marks) + 1e-9)) {
      throw badRequest(`Enter marks for every criterion of the current rubric (v${version}) before approving.`);
    }
    const total = Math.min(a.question.maxMarks, r6(criteria.reduce((t, c) => t + cm[c.id], 0)));
    await this.prisma.examCorrectionAnswer.update({
      where: { id },
      data: { markStatus: 'approved', finalMarks: total, rubricVersion: version, approvedAt: new Date(), approvedById: user.id, approvedByName: user.fullName, flags: jArr<string>(a.flags).filter((f) => !f.startsWith(FLAG_REVIEW)) },
    });
    await this.event(id, user, { kind: 'approve', marksBefore: a.finalMarks, marksAfter: total, reason: 'Approved' });
    await this.audit.record(user, { action: 'approve', entityType: 'exam_answer', entityId: id, campusId: l.exam.campusId, sensitive: true, description: `Approved ${total}/${a.question.maxMarks} for ${await this.who(l)}` }, req);
    return this.done(id, a.submissionId, `Q${a.question.number} approved`);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  async reopen(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const l = await this.load(user, id);
    const a = l.answer;
    if (a.markStatus !== 'approved') throw badRequest('This answer is not approved.');
    await this.prisma.examCorrectionAnswer.update({ where: { id }, data: { markStatus: 'reviewed', approvedAt: null, approvedById: null, approvedByName: null } });
    await this.event(id, user, { kind: 'reopen', marksBefore: a.finalMarks, marksAfter: a.finalMarks, reason: dto.reason.trim() });
    await this.audit.record(user, { action: 'update', entityType: 'exam_answer', entityId: id, campusId: l.exam.campusId, sensitive: true, description: `Reopened the approved marks of ${await this.who(l)}: ${dto.reason.trim()}` }, req);
    return this.done(id, a.submissionId, 'Reopened');
  }

  @Post(':id/request-review')
  @HttpCode(200)
  async requestReview(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const l = await this.load(user, id);
    const a = l.answer;
    if (a.markStatus === 'approved') throw conflict('Reopen the answer before asking for a review.');
    const reason = dto.reason.trim();
    await this.prisma.examCorrectionAnswer.update({ where: { id }, data: { markStatus: 'needs_review', flags: [...new Set([...jArr<string>(a.flags), `${FLAG_REVIEW} by ${user.fullName}: ${reason}`])] } });
    await this.event(id, user, { kind: 'request_review', marksBefore: a.finalMarks, marksAfter: a.finalMarks, reason });
    const what = await this.who(l);
    await this.audit.record(user, { action: 'update', entityType: 'exam_answer', entityId: id, campusId: l.exam.campusId, sensitive: true, description: `Requested a review of ${what}: ${reason}` }, req);
    const teachers = await this.prisma.examCorrectionTeacher.findMany({ where: { examId: l.exam.id }, select: { userId: true } });
    const to = [...new Set([...teachers.map((t) => t.userId), ...(l.exam.createdById ? [l.exam.createdById] : [])])].filter((u) => u !== user.id);
    if (to.length) {
      await this.notifications.notifyUsers(to, {
        category: 'Attention', module: 'exam-correction', icon: 'scan', campusId: l.exam.campusId,
        title: `Review requested: ${what}`, body: `${user.fullName}: ${reason}`, route: `/paper-correction/sheets/${a.submissionId}`,
      });
    }
    return this.done(id, a.submissionId, 'Flagged for review');
  }

  @Post(':id/evaluate')
  @HttpCode(200)
  async evaluate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const l = await this.load(user, id);
    if (l.answer.markStatus === 'approved') throw conflict('Reopen the answer before marking it again.');
    const state = await this.access.aiState();
    if (!state.status.marking_available) throw unavailable(state.status.marking_reason);
    await this.criteria(l.answer.questionId);
    await this.queue.enqueue(l.answer.submissionId, 'Marking', { answerIds: [id], force: true, by: user });
    await this.audit.record(user, { action: 'update', entityType: 'exam_answer', entityId: id, campusId: l.exam.campusId, description: `Asked the AI to mark ${await this.who(l)} again` }, req);
    return ok(null, 'Re-evaluating…');
  }

  @Get(':id/history')
  async history(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const l = await this.access.answer(user, id);
    const [events, evaluations] = await Promise.all([
      this.prisma.examCorrectionAnswerEvent.findMany({ where: { answerId: id }, orderBy: { at: 'desc' } }),
      this.prisma.examCorrectionEvaluation.findMany({ where: { answerId: id }, orderBy: { createdAt: 'desc' } }),
    ]);
    await this.audit.view(user, 'exam_answer_history', id, `Viewed the marking history of ${await this.who(l)}`, req, l.exam.campusId);
    const label: Record<string, string> = { marks: '', text: 'Transcription corrected', verify: 'Transcription verified', approve: 'Approved', reopen: 'Reopened', request_review: 'Review requested' };
    return {
      overrides: events.map((e) => ({
        original_marks: e.marksBefore,
        new_marks: e.marksAfter ?? e.marksBefore ?? 0,
        reason: e.kind === 'marks' ? e.reason : e.reason && e.reason !== label[e.kind] ? `${label[e.kind]}: ${e.reason}` : label[e.kind] ?? e.kind,
        by: e.byName,
        at: e.at.toISOString(),
      })),
      evaluations: evaluations.map(evaluationDto),
    };
  }
}
