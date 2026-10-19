import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { ExamCorrectionExam } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { badRequest, conflict, fieldError, notFound, unavailable } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import type { UploadedFileLike } from '../operations/storage.service';
import { EcAccess } from './ec.access';
import { EcAudit } from './ec.audit';
import { EvaluateDto, IdentityDto, PageOrderDto, RotateDto, SheetFieldsDto } from './ec.dto';
import { EcPages, MAX_FILE_MB, MAX_SHEET_PAGES, type PreparedPage } from './ec.pages.service';
import { EcPipeline } from './ec.pipeline.service';
import type { AnswerReading } from './ec.prompts';
import { EcQueue } from './ec.queue.service';
import { matchAdmission, naturalCompare } from './ec.util';
import { BUSY, EcViews, jArr } from './ec.views.service';

const MAX_BULK_FILES = 150;
type Student = { id: string; fullName: string; admissionNo: string };

/** Answer sheets: upload (single and bulk), the review screen, reading/marking, identity, pages. */
@Controller('exam-correction/api')
@RequirePermissions('assessments.manage')
export class EcSheetsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: EcAccess,
    private readonly views: EcViews,
    private readonly pages: EcPages,
    private readonly pipeline: EcPipeline,
    private readonly queue: EcQueue,
    private readonly audit: EcAudit,
  ) {}

  @Get('exams/:id/submissions')
  async list(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const exam = await this.access.exam(user, id);
    const subs = await this.prisma.examCorrectionSubmission.findMany({ where: { examId: id }, orderBy: { createdAt: 'asc' } });
    return this.views.sheetRows(subs, exam);
  }

  /** Students who sit the examination: its class, or only its section when one is set. */
  private async roster(exam: ExamCorrectionExam): Promise<Student[]> {
    if (!exam.classId) throw badRequest(`The class "${exam.className}" is not found in Holy Sai. Edit the examination and choose the class again.`);
    return this.prisma.student.findMany({
      where: { status: 'active', ...(exam.sectionId ? { sectionId: exam.sectionId } : { section: { classId: exam.classId } }) },
      select: { id: true, fullName: true, admissionNo: true },
    });
  }

  /** Creates the sheet (replacing an earlier one that has no approved marks) and stores its pages. */
  private async createSheet(exam: ExamCorrectionExam, student: Student, pages: PreparedPage[], filename: string, user: AuthUser) {
    const existing = await this.prisma.examCorrectionSubmission.findUnique({ where: { examId_studentId: { examId: exam.id, studentId: student.id } } });
    let replaced = false;
    if (existing) {
      if (await this.prisma.examCorrectionAnswer.count({ where: { submissionId: existing.id, markStatus: 'approved' } })) {
        throw conflict(`Marks for ${student.fullName} are already approved. Reopen them before replacing the sheet.`);
      }
      if (await this.prisma.examCorrectionJob.count({ where: { submissionId: existing.id, status: { in: BUSY } } })) {
        throw conflict(`${student.fullName}'s sheet is being read or marked. Wait for it to finish before replacing it.`);
      }
      await this.queue.removeSheet(existing.id);
      replaced = true;
    }
    const sub = await this.prisma.examCorrectionSubmission.create({
      data: { examId: exam.id, studentId: student.id, filename: filename.slice(0, 300), uploadedById: user.id, uploadedByName: user.fullName },
    });
    try {
      await this.pages.store(sub.id, pages);
    } catch (err) {
      await this.prisma.examCorrectionSubmission.delete({ where: { id: sub.id } }).catch(() => undefined);
      throw err;
    }
    return { sub, replaced };
  }

  /** Queues reading (then marking) when asked and possible; returns a note when the AI cannot read yet. */
  private async startIfWanted(subId: string, auto: boolean, user: AuthUser): Promise<string | null> {
    if (!auto) return null;
    const state = await this.access.aiState();
    if (!state.status.reading_available) return `Uploaded. The AI cannot read it yet: ${state.status.reading_reason}`;
    await this.queue.enqueue(subId, 'Reading', { evaluateAfter: true, by: user });
    return null;
  }

  @Post('exams/:id/submissions')
  @HttpCode(200)
  @UseInterceptors(FilesInterceptor('files', MAX_SHEET_PAGES, { limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_SHEET_PAGES }, defParamCharset: 'utf8' }))
  async upload(@Param('id', ParseUUIDPipe) id: string, @UploadedFiles() files: UploadedFileLike[] | undefined, @Body() dto: SheetFieldsDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const exam = await this.access.exam(user, id);
    this.access.assertOpen(exam);
    if (!dto.student_id) throw fieldError('student_id', 'Choose the student');
    const student = (await this.roster(exam)).find((s) => s.id === dto.student_id);
    if (!student) throw badRequest(`This student is not in ${exam.className}${exam.section ? ` · Section ${exam.section}` : ''}.`);
    const pages = await this.pages.prepare(files ?? []);
    const { sub, replaced } = await this.createSheet(exam, student, pages, (files ?? []).map((f) => f.originalname).join(', '), user);
    const note = await this.startIfWanted(sub.id, dto.auto_process !== 'false', user);
    await this.audit.record(user, {
      action: replaced ? 'update' : 'create', entityType: 'exam_sheet', entityId: sub.id, campusId: exam.campusId, sensitive: true,
      description: `${replaced ? 'Replaced' : 'Uploaded'} the answer sheet of ${student.fullName} (${student.admissionNo}) for "${exam.name}" — ${pages.length} page(s)`,
    }, req);
    const [row] = await this.views.sheetRows([await this.prisma.examCorrectionSubmission.findUniqueOrThrow({ where: { id: sub.id } })], exam);
    const notes = [replaced ? 'The earlier sheet was replaced.' : '', note ?? ''].filter(Boolean).join(' ');
    return ok({ ...row, ...(notes ? { note: notes } : {}) }, `${student.fullName}’s answer sheet uploaded`);
  }

  @Post('exams/:id/submissions/bulk')
  @HttpCode(200)
  @UseInterceptors(FilesInterceptor('files', MAX_BULK_FILES, { limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_BULK_FILES }, defParamCharset: 'utf8' }))
  async bulk(@Param('id', ParseUUIDPipe) id: string, @UploadedFiles() files: UploadedFileLike[] | undefined, @Body() dto: SheetFieldsDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const exam = await this.access.exam(user, id);
    this.access.assertOpen(exam);
    const list = files ?? [];
    if (!list.length) throw badRequest('Choose files named with admission numbers.');
    const roster = await this.roster(exam);
    const byAdmission = new Map(roster.map((s) => [s.admissionNo, s]));
    const results = new Map<UploadedFileLike, { file: string; ok: boolean; student?: string; error?: string }>();
    const groups = new Map<string, UploadedFileLike[]>();
    for (const f of list) {
      const no = matchAdmission(f.originalname, [...byAdmission.keys()]);
      if (!no) {
        results.set(f, { file: f.originalname, ok: false, error: `no admission number of ${exam.className}${exam.section ? ` ${exam.section}` : ''} in the file name` });
        continue;
      }
      groups.set(no, [...(groups.get(no) ?? []), f]);
    }
    const auto = dto.auto_process !== 'false';
    let uploaded = 0;
    let notReadNote: string | null = null;
    for (const [no, group] of groups) {
      const student = byAdmission.get(no)!;
      group.sort((a, b) => naturalCompare(a.originalname, b.originalname));
      try {
        const pages = await this.pages.prepare(group);
        const { sub, replaced } = await this.createSheet(exam, student, pages, group.map((f) => f.originalname).join(', '), user);
        notReadNote = (await this.startIfWanted(sub.id, auto, user)) ?? notReadNote;
        uploaded++;
        for (const f of group) results.set(f, { file: f.originalname, ok: true, student: `${student.fullName}${replaced ? ' (replaced)' : ''}` });
      } catch (err) {
        for (const f of group) results.set(f, { file: f.originalname, ok: false, error: (err as Error).message });
      }
    }
    await this.audit.record(user, {
      action: 'create', entityType: 'exam_sheet', entityId: id, campusId: exam.campusId, sensitive: true,
      description: `Bulk upload for "${exam.name}": ${uploaded} answer sheet(s) from ${list.length} file(s)`,
    }, req);
    return ok({ results: list.map((f) => results.get(f)!) }, `${uploaded} answer sheet(s) uploaded${notReadNote ? `. ${notReadNote}` : ''}`);
  }

  @Get('submissions/:id')
  async detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { sub, exam } = await this.access.submission(user, id);
    const sheet = await this.views.sheet(sub, exam);
    await this.audit.view(user, 'exam_sheet', id, `Viewed the answer sheet of ${sheet.student_full.name} (${sheet.student_full.admission_no}) for "${exam.name}"`, req, exam.campusId);
    return sheet;
  }

  @Post('submissions/:id/process')
  @HttpCode(200)
  async process(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { sub, exam } = await this.access.submission(user, id);
    this.access.assertOpen(exam);
    const state = await this.access.aiState();
    if (!state.status.reading_available) throw unavailable(state.status.reading_reason);
    const job = await this.queue.enqueue(sub.id, 'Reading', { evaluateAfter: true, by: user });
    await this.audit.record(user, { action: 'update', entityType: 'exam_sheet', entityId: id, campusId: exam.campusId, description: `Started reading and marking an answer sheet of "${exam.name}"` }, req);
    return ok({ job_id: job.id }, 'Reading started');
  }

  @Post('submissions/:id/evaluate')
  @HttpCode(200)
  async evaluate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EvaluateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { sub, exam } = await this.access.submission(user, id);
    this.access.assertOpen(exam);
    const state = await this.access.aiState();
    if (!state.status.marking_available) throw unavailable(state.status.marking_reason);
    if (!(await this.prisma.examCorrectionAnswer.count({ where: { submissionId: id } }))) throw badRequest('Read the sheet first.');
    const job = await this.queue.enqueue(sub.id, 'Marking', { force: dto.force === true, by: user });
    await this.audit.record(user, { action: 'update', entityType: 'exam_sheet', entityId: id, campusId: exam.campusId, description: `Started marking ${dto.force ? 'all unapproved' : 'unmarked'} answers of a sheet of "${exam.name}"` }, req);
    return ok({ job_id: job.id }, 'Marking started');
  }

  @Post('submissions/:id/identity')
  @HttpCode(200)
  async identity(@Param('id', ParseUUIDPipe) id: string, @Body() dto: IdentityDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { sub, exam } = await this.access.submission(user, id);
    this.access.assertOpen(exam);
    const students = await this.prisma.student.findMany({ where: { id: { in: [sub.studentId, dto.student_id ?? sub.studentId] } }, select: { id: true, fullName: true, admissionNo: true, section: { select: { classId: true } } } });
    const from = students.find((s) => s.id === sub.studentId);
    let to = from;
    if (dto.student_id && dto.student_id !== sub.studentId) {
      to = students.find((s) => s.id === dto.student_id);
      if (!to) throw notFound('Student');
      if (exam.classId && to.section.classId !== exam.classId) throw badRequest(`${to.fullName} is not in ${exam.className}.`);
      if (await this.prisma.examCorrectionSubmission.count({ where: { examId: exam.id, studentId: to.id } })) throw conflict(`${to.fullName} already has an answer sheet in this examination.`);
    }
    await this.prisma.examCorrectionSubmission.update({
      where: { id },
      data: {
        studentId: to!.id,
        identityVerified: dto.verified,
        identityVerifiedById: dto.verified ? user.id : null,
        identityVerifiedByName: dto.verified ? user.fullName : null,
        identityVerifiedAt: dto.verified ? new Date() : null,
      },
    });
    await this.pipeline.refresh(id);
    const moved = to!.id !== sub.studentId;
    await this.audit.record(user, {
      action: 'update', entityType: 'exam_sheet', entityId: id, campusId: exam.campusId, sensitive: true,
      description: moved
        ? `Reassigned an answer sheet of "${exam.name}" from ${from?.fullName ?? 'unknown'} (${from?.admissionNo ?? ''}) to ${to!.fullName} (${to!.admissionNo})${dto.verified ? ' and confirmed it' : ''}`
        : `${dto.verified ? 'Confirmed' : 'Unconfirmed'} that the answer sheet is ${to?.fullName ?? 'the student'}'s (${exam.name})`,
    }, req);
    const [row] = await this.views.sheetRows([await this.prisma.examCorrectionSubmission.findUniqueOrThrow({ where: { id } })], exam);
    return ok(row, moved ? 'Student updated' : dto.verified ? 'Identity confirmed' : 'Identity not confirmed');
  }

  @Post('submissions/:id/pages/order')
  @HttpCode(200)
  async order(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PageOrderDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { exam } = await this.access.submission(user, id);
    this.access.assertOpen(exam);
    const pages = await this.prisma.examCorrectionPage.findMany({ where: { submissionId: id }, orderBy: { pageNo: 'asc' } });
    if (dto.page_ids.length !== pages.length || pages.some((p) => !dto.page_ids.includes(p.id))) throw badRequest('The page list has changed. Reload and try again.');
    await this.prisma.$transaction(dto.page_ids.map((pid, i) => this.prisma.examCorrectionPage.update({ where: { id: pid }, data: { pageNo: i + 1 } })));
    await this.audit.record(user, { action: 'update', entityType: 'exam_sheet', entityId: id, campusId: exam.campusId, description: `Reordered the pages of an answer sheet of "${exam.name}": ${dto.page_ids.map((pid) => pages.find((p) => p.id === pid)!.pageNo).join(', ')}` }, req);
    return ok(null, 'Page order saved');
  }

  @Post('submissions/:id/extractions/:eid/activate')
  @HttpCode(200)
  async activate(@Param('id', ParseUUIDPipe) id: string, @Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { exam } = await this.access.submission(user, id);
    this.access.assertOpen(exam);
    const ext = await this.prisma.examCorrectionExtraction.findFirst({ where: { id: eid, submissionId: id } });
    if (!ext) throw notFound('Reading');
    if (ext.status !== 'done') throw badRequest('Only a completed reading can be used.');
    if (await this.prisma.examCorrectionJob.count({ where: { submissionId: id, status: { in: BUSY } } })) throw conflict('Wait for the current reading or marking to finish.');
    await this.prisma.$transaction([
      this.prisma.examCorrectionExtraction.updateMany({ where: { submissionId: id, active: true }, data: { active: false } }),
      this.prisma.examCorrectionExtraction.update({ where: { id: eid }, data: { active: true } }),
    ]);
    const questions = await this.prisma.examCorrectionQuestion.findMany({ where: { examId: exam.id }, orderBy: { order: 'asc' } });
    await this.pipeline.applyReading(id, eid, jArr<AnswerReading>(ext.answers), questions);
    await this.pipeline.refresh(id);
    await this.audit.record(user, { action: 'update', entityType: 'exam_sheet', entityId: id, campusId: exam.campusId, description: `Switched an answer sheet of "${exam.name}" to the reading of ${ext.createdAt.toISOString()} (${ext.model ?? 'AI'})` }, req);
    return ok(null, 'Reading switched');
  }

  @Get('pages/:id/image')
  async image(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request): Promise<StreamableFile> {
    const { page, sub, exam } = await this.access.page(user, id);
    await this.audit.view(user, 'exam_sheet', sub.id, `Viewed pages of an answer sheet of "${exam.name}"`, req, exam.campusId);
    return this.pages.image(page);
  }

  @Post('pages/:id/rotate')
  @HttpCode(200)
  async rotate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RotateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { page, exam } = await this.access.page(user, id);
    this.access.assertOpen(exam);
    const rotation = await this.pages.rotate(page, dto.degrees);
    await this.audit.record(user, { action: 'update', entityType: 'exam_sheet', entityId: page.submissionId, campusId: exam.campusId, description: `Rotated page ${page.pageNo} of an answer sheet of "${exam.name}" to ${rotation}°` }, req);
    return ok({ rotation }, 'Page rotated');
  }
}
