import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, StreamableFile } from '@nestjs/common';
import type { ExamCorrectionExam } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { badRequest, fieldError, forbidden, unavailable } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EcAccess } from './ec.access';
import { EcAudit } from './ec.audit';
import { ExamDto, StudentsQuery, TeachersDto } from './ec.dto';
import { EcQueue } from './ec.queue.service';
import { EcReports } from './ec.reports.service';
import { EcRoster } from './ec.roster.service';
import { RESULT_MOVES, RESULTS, type ResultsStatus } from './ec.util';
import { BUSY, EcViews } from './ec.views.service';

/** Examinations, their teachers, results status, reports, and the class roster (EV = /exam-correction/api). */
@Controller('exam-correction/api')
@RequirePermissions('assessments.manage')
export class EcExamsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly access: EcAccess,
    private readonly views: EcViews,
    private readonly roster: EcRoster,
    private readonly queue: EcQueue,
    private readonly reports: EcReports,
    private readonly notifications: NotificationsService,
    private readonly audit: EcAudit,
  ) {}

  @Get('exams')
  async list(@CurrentUser() user: AuthUser) {
    const exams = await this.prisma.examCorrectionExam.findMany({ where: this.access.examWhere(user), orderBy: { createdAt: 'desc' } });
    return this.views.exams(exams);
  }

  @Get('exams/:id')
  async detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.views.exam(await this.access.exam(user, id));
  }

  private async examData(dto: ExamDto, user: AuthUser, existing?: ExamCorrectionExam) {
    const label = dto.class_name.trim();
    const sameClass = existing && existing.className === label;
    const cls = await this.roster.resolveClass(label);
    if (!cls && !sameClass) throw fieldError('classId', 'Choose a class');
    if (cls) {
      const campusId = this.scope.campus(user);
      if (campusId && cls.campusId !== campusId) throw fieldError('classId', 'This class is outside your campus');
    }
    const sectionName = (dto.section ?? '').trim();
    const section = sectionName && cls ? cls.sections.find((s) => s.name.toLowerCase() === sectionName.toLowerCase()) : null;
    if (sectionName && cls && !section) throw fieldError('section', 'Choose a section of this class');
    const subject = await this.roster.resolveSubject(dto.subject);
    if (!subject && dto.subject.trim() !== existing?.subject) throw fieldError('subject', 'Choose a subject');
    return {
      name: dto.name.trim(),
      academicYear: dto.academic_year.trim(),
      className: cls ? this.roster.classLabel(cls) : label,
      section: section?.name ?? (cls ? '' : sectionName),
      subject: subject?.name ?? dto.subject.trim(),
      gradeLevel: (dto.grade_level ?? '').trim(),
      instructions: (dto.instructions ?? '').trim(),
      campusId: cls?.campusId ?? existing?.campusId ?? null,
      classId: cls?.id ?? existing?.classId ?? null,
      sectionId: section?.id ?? (cls ? null : existing?.sectionId ?? null),
      subjectId: subject?.id ?? existing?.subjectId ?? null,
    };
  }

  @Post('exams')
  async create(@Body() dto: ExamDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    this.access.assertManager(user, 'Only exam coordinators create examinations');
    const data = await this.examData(dto, user);
    const exam = await this.prisma.examCorrectionExam.create({ data: { ...data, createdById: user.id, createdByName: user.fullName } });
    await this.audit.record(user, { action: 'create', entityType: 'exam', entityId: exam.id, campusId: exam.campusId, description: `Created examination "${exam.name}" (${exam.className}${exam.section ? ` ${exam.section}` : ''}, ${exam.subject})` }, req);
    return ok(await this.views.exam(exam), 'Examination created');
  }

  @Put('exams/:id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ExamDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    this.access.assertManager(user, 'Only exam coordinators edit examinations');
    const existing = await this.access.exam(user, id);
    const data = await this.examData(dto, user, existing);
    const exam = await this.prisma.examCorrectionExam.update({ where: { id }, data });
    const changed = (Object.keys(data) as (keyof typeof data)[]).filter((k) => String(existing[k] ?? '') !== String(data[k] ?? ''));
    await this.audit.record(user, { action: 'update', entityType: 'exam', entityId: id, campusId: exam.campusId, description: `Edited examination "${exam.name}"${changed.length ? ` (${changed.join(', ')})` : ''}` }, req);
    return ok(await this.views.exam(exam), 'Examination updated');
  }

  @Put('exams/:id/teachers')
  async teachers(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TeachersDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    this.access.assertManager(user, 'Only exam coordinators assign teachers');
    const exam = await this.access.exam(user, id);
    const users = await this.prisma.user.findMany({
      where: { id: { in: dto.user_ids }, role: { permissions: { some: { permissionKey: 'assessments.manage' } } } },
      select: { id: true, fullName: true },
    });
    if (users.length !== dto.user_ids.length) throw badRequest('Some of the chosen people cannot mark papers. Reload and try again.');
    const before = await this.prisma.examCorrectionTeacher.findMany({ where: { examId: id } });
    const added = dto.user_ids.filter((u) => !before.some((b) => b.userId === u));
    const removed = before.filter((b) => !dto.user_ids.includes(b.userId));
    await this.prisma.$transaction([
      this.prisma.examCorrectionTeacher.deleteMany({ where: { examId: id, userId: { notIn: dto.user_ids } } }),
      this.prisma.examCorrectionTeacher.createMany({ data: added.map((userId) => ({ examId: id, userId, assignedById: user.id })), skipDuplicates: true }),
    ]);
    if (added.length) {
      await this.notifications.notifyUsers(added, {
        category: 'Information', module: 'exam-correction', icon: 'scan', campusId: exam.campusId,
        title: `You can mark ${exam.name}`, body: `${exam.className}${exam.section ? ` · Section ${exam.section}` : ''} · ${exam.subject}. Upload and review the answer sheets in Paper Correction.`,
        route: `/paper-correction/exams/${id}`,
      });
    }
    const name = (uid: string) => users.find((u) => u.id === uid)?.fullName ?? uid;
    await this.audit.record(user, {
      action: 'update', entityType: 'exam', entityId: id, campusId: exam.campusId,
      description: `Assigned teachers for "${exam.name}": ${added.length ? `added ${added.map(name).join(', ')}` : 'none added'}${removed.length ? `; removed ${removed.length}` : ''}`,
    }, req);
    return ok(await this.views.exam(exam), 'Teachers assigned');
  }

  @Post('exams/:id/results/:to')
  @HttpCode(200)
  async results(@Param('id', ParseUUIDPipe) id: string, @Param('to') to: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    this.access.assertManager(user, 'Only exam coordinators change the results status');
    const exam = await this.access.exam(user, id);
    if (!RESULTS.includes(to as ResultsStatus)) throw badRequest('Unknown results status');
    const from = exam.resultsStatus as ResultsStatus;
    if (!RESULT_MOVES[from]?.includes(to as ResultsStatus)) throw badRequest(`Results cannot move from ${from} to ${to}.`);
    let note = '';
    if (to === 'reviewed' || to === 'approved') {
      const busy = await this.prisma.examCorrectionJob.count({ where: { status: { in: BUSY }, submission: { examId: id } } });
      if (busy) throw badRequest(`${busy} answer sheet(s) are still being read or marked. Wait for them to finish.`);
      const subs = await this.prisma.examCorrectionSubmission.findMany({ where: { examId: id }, select: { id: true, status: true, identityVerified: true, _count: { select: { answers: true } } } });
      if (!subs.length) throw badRequest('No answer sheets have been uploaded yet.');
      if (to === 'approved') {
        const open = subs.filter((s) => s._count.answers > 0 && s.status !== 'approved');
        if (open.length) throw badRequest(`${open.length} answer sheet(s) still have marks to approve or a student to confirm. Approve them first.`);
        const approved = subs.filter((s) => s.status === 'approved').length;
        if (!approved) throw badRequest('No answer sheet is fully approved yet.');
        const unread = subs.length - approved;
        if (unread) note = ` ${unread} sheet(s) without readable answers are not included.`;
      }
    }
    const updated = await this.prisma.examCorrectionExam.update({
      where: { id },
      data: { resultsStatus: to, resultsChangedAt: new Date(), resultsChangedById: user.id, resultsChangedByName: user.fullName },
    });
    await this.audit.record(user, {
      action: to === 'approved' ? 'approve' : to === 'published' ? 'publish' : 'update', entityType: 'exam', entityId: id, campusId: exam.campusId, sensitive: true,
      description: `Results of "${exam.name}": ${from} → ${to}`,
    }, req);
    if (to === 'published') {
      const teachers = await this.prisma.examCorrectionTeacher.findMany({ where: { examId: id, userId: { not: user.id } }, select: { userId: true } });
      if (teachers.length) {
        await this.notifications.notifyUsers(teachers.map((t) => t.userId), {
          category: 'Completed', module: 'exam-correction', icon: 'scan', campusId: exam.campusId,
          title: `Results published: ${exam.name}`, body: `${user.fullName} published the results.`, route: `/paper-correction/exams/${id}?tab=results`,
        });
      }
    }
    return ok(await this.views.exam(updated), `Results are now ${to}.${note}`);
  }

  @Post('exams/:id/reevaluate')
  @HttpCode(200)
  async reevaluate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const exam = await this.access.exam(user, id);
    this.access.assertOpen(exam, 'marks');
    const state = await this.access.aiState();
    if (!state.status.marking_available) throw unavailable(state.status.marking_reason);
    const subs = await this.prisma.examCorrectionSubmission.findMany({
      where: { examId: id, answers: { some: { markStatus: { not: 'approved' } } }, jobs: { none: { status: { in: BUSY } } } },
      select: { id: true },
    });
    let queued = 0;
    for (const s of subs) {
      try {
        await this.queue.enqueue(s.id, 'Marking', { force: true, by: user });
        queued++;
      } catch {
        // Started meanwhile — skip it.
      }
    }
    await this.audit.record(user, { action: 'update', entityType: 'exam', entityId: id, campusId: exam.campusId, description: `Queued ${queued} sheet(s) of "${exam.name}" for re-evaluation of unapproved answers` }, req);
    return ok({ jobs_queued: queued }, `${queued} sheet(s) queued for re-evaluation`);
  }

  @Get('exams/:id/report')
  async report(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const exam = await this.access.exam(user, id);
    await this.audit.view(user, 'exam_report', id, `Viewed results of "${exam.name}"`, req, exam.campusId);
    return this.reports.report(exam);
  }

  @Get('exams/:id/report.csv')
  async reportCsv(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request): Promise<StreamableFile> {
    const exam = await this.access.exam(user, id);
    await this.audit.record(user, { action: 'export', entityType: 'exam', entityId: id, campusId: exam.campusId, sensitive: true, description: `Downloaded the results of "${exam.name}" (CSV)` }, req);
    return this.reports.csv(exam);
  }

  @Get('users')
  async users(@CurrentUser() user: AuthUser) {
    this.access.assertManager(user, 'Only exam coordinators assign teachers');
    return this.roster.users(user);
  }

  /** Students of an examination's class (all sections). Teachers only see classes of their examinations. */
  @Get('students')
  async students(@Query() q: StudentsQuery, @CurrentUser() user: AuthUser) {
    const label = (q.class_name ?? '').trim();
    if (!label) return [];
    const exam = await this.prisma.examCorrectionExam.findFirst({ where: { AND: [{ className: label }, this.access.examWhere(user)] }, orderBy: { createdAt: 'desc' } });
    if (!exam && !this.access.isManager(user)) throw forbidden('This class has no examination assigned to you');
    const classId = exam?.classId ?? (await this.roster.resolveClass(label))?.id;
    if (!classId) return [];
    if (!exam) {
      const cls = await this.prisma.schoolClass.findUnique({ where: { id: classId }, select: { campusId: true } });
      const campusId = this.scope.campus(user);
      if (campusId && cls?.campusId !== campusId) throw forbidden('This class is outside your campus');
    }
    return this.roster.students(classId, label);
  }
}
