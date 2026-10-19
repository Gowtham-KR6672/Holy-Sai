import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Homework, Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AcademicsAccess } from './academics.access';
import { asDate, dayKey, iso, round1, schoolToday, shortDate } from './academics.util';

class HomeworkQuery extends ListQuery {
  @IsOptional() @IsIn(['Open', 'Overdue', 'Closed', 'Draft']) status?: string;
  @IsOptional() @IsString() sectionId?: string;
  @IsOptional() @IsString() subjectId?: string;
}

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class HomeworkDto {
  @IsUUID('all', { message: 'Choose a class' }) sectionId: string;
  @IsUUID('all', { message: 'Choose a subject' }) subjectId: string;
  @IsString() @MinLength(3, { message: 'Give the homework a title' }) @MaxLength(160) title: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000, { message: 'Keep the instructions under 2000 characters' }) instructions?: string | null;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Choose a due date' }) dueOn: string;
  @IsOptional() @IsIn(['Draft', 'Open']) status?: 'Draft' | 'Open';
}

class SubmissionDto {
  @IsUUID('all', { message: 'Unknown student' }) studentId: string;
  @IsIn(['Missing', 'Submitted', 'Late', 'Reviewed'], { message: 'Choose a submission status' }) status: string;
  @IsOptional() @IsString() @MaxLength(1000) feedback?: string;
}

/** Shown status: open homework becomes "Closing today" on its due date and "Overdue" after it. */
export function displayStatus(h: Pick<Homework, 'status' | 'dueOn'>, today = schoolToday()) {
  if (h.status !== 'Open') return h.status;
  const due = dayKey(h.dueOn);
  return due < today ? 'Overdue' : due === today ? 'Closing today' : 'Open';
}

@Controller('academics/homework')
export class HomeworkController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademicsAccess,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async scopeWhere(user: AuthUser, campusId?: string): Promise<Prisma.HomeworkWhereInput> {
    const s = await this.access.sectionIdsOrCampus(user, campusId);
    if (s.sectionIds) return { sectionId: { in: s.sectionIds } };
    return s.campusId ? { campusId: s.campusId } : {};
  }

  private async rows(list: (Homework & { _count: { submissions: number } })[]) {
    const [sections, subjects, counts] = await Promise.all([
      this.access.sectionInfo(list.map((h) => h.sectionId)),
      this.access.subjectNames(list.map((h) => h.subjectId)),
      this.access.studentCounts([...new Set(list.map((h) => h.sectionId))]),
    ]);
    const today = schoolToday();
    return list.map((h) => ({
      id: h.id,
      title: h.title,
      instructions: h.instructions,
      status: h.status,
      displayStatus: displayStatus(h, today),
      assignedOn: dayKey(h.assignedOn),
      dueOn: dayKey(h.dueOn),
      sectionId: h.sectionId,
      sectionLabel: sections.get(h.sectionId)?.label ?? '',
      subjectId: h.subjectId,
      subject: subjects.get(h.subjectId) ?? '',
      assignedBy: h.assignedByName,
      submitted: h._count.submissions,
      of: counts.get(h.sectionId) ?? 0,
    }));
  }

  @Get('summary')
  @RequirePermissions('academics.read')
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const where = await this.scopeWhere(user, q.campusId);
    const today = asDate(schoolToday());
    const open = await this.prisma.homework.findMany({ where: { ...where, status: 'Open' }, include: { _count: { select: { submissions: true } } } });
    const counts = await this.access.studentCounts([...new Set(open.map((h) => h.sectionId))]);
    const rates = open.filter((h) => (counts.get(h.sectionId) ?? 0) > 0).map((h) => h._count.submissions / counts.get(h.sectionId)!);
    const overdue = open.filter((h) => h.dueOn < today);
    const subjects = await this.access.subjectNames(overdue.map((h) => h.subjectId));
    const overdueSubjects = [...new Set(overdue.map((h) => subjects.get(h.subjectId)).filter((x): x is string => !!x))].slice(0, 2);

    // Students whose submission rate this year (published homework already due) is under 50%.
    const year = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    const due = await this.prisma.homework.findMany({
      where: { ...where, status: { in: ['Open', 'Closed'] }, dueOn: { lte: today, ...(year ? { gte: year.startsOn } : {}) } },
      select: { id: true, sectionId: true, submissions: { select: { studentId: true } } },
    });
    let studentsBelow50 = 0;
    if (due.length) {
      const students = await this.prisma.student.findMany({ where: { status: 'active', sectionId: { in: [...new Set(due.map((h) => h.sectionId))] } }, select: { id: true, sectionId: true } });
      for (const st of students) {
        const set = due.filter((h) => h.sectionId === st.sectionId);
        if (!set.length) continue;
        const done = set.filter((h) => h.submissions.some((x) => x.studentId === st.id)).length;
        if (done / set.length < 0.5) studentsBelow50++;
      }
    }
    return {
      open: open.length - overdue.length,
      averageSubmission: rates.length ? Math.round(round1((100 * rates.reduce((a, b) => a + b, 0)) / rates.length)) : null,
      overdue: overdue.length,
      overdueSubjects,
      studentsBelow50,
    };
  }

  @Get()
  @RequirePermissions('academics.read')
  async list(@Query() q: HomeworkQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const today = asDate(schoolToday());
    const statusWhere: Prisma.HomeworkWhereInput =
      q.status === 'Open' ? { status: 'Open', dueOn: { gte: today } }
        : q.status === 'Overdue' ? { status: 'Open', dueOn: { lt: today } }
          : q.status ? { status: q.status } : {};
    const where: Prisma.HomeworkWhereInput = {
      AND: [
        await this.scopeWhere(user, q.campusId),
        statusWhere,
        q.sectionId ? { sectionId: q.sectionId } : {},
        q.subjectId ? { subjectId: q.subjectId } : {},
        q.q ? { OR: [{ title: like(q.q) }, { instructions: like(q.q) }, { assignedByName: like(q.q) }] } : {},
      ],
    };
    const dir = q.dir ?? 'asc';
    const orderBy: Prisma.HomeworkOrderByWithRelationInput[] =
      q.sort === 'title' ? [{ title: dir }] : q.sort === 'status' ? [{ status: dir }, { dueOn: 'asc' }] : q.sort === 'submitted' ? [{ submissions: { _count: dir } }] : [{ dueOn: dir }, { title: 'asc' }];
    const [list, total] = await Promise.all([
      this.prisma.homework.findMany({ where, orderBy, skip: p.skip, take: p.take, include: { _count: { select: { submissions: true } } } }),
      this.prisma.homework.count({ where }),
    ]);
    return paged(await this.rows(list), total, p);
  }

  @Post()
  @RequirePermissions('academics.manage')
  async create(@Body() dto: HomeworkDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const s = await this.access.assertSection(user, dto.sectionId).catch(() => {
      throw fieldError('sectionId', 'Choose one of your classes');
    });
    if (!(await this.prisma.subject.findUnique({ where: { id: dto.subjectId } }))) throw fieldError('subjectId', 'Choose a subject');
    const today = schoolToday();
    if (dto.dueOn < today) throw fieldError('dueOn', 'The due date cannot be in the past');
    const status = dto.status ?? 'Open';
    const h = await this.prisma.homework.create({
      data: {
        title: dto.title.trim(),
        instructions: dto.instructions?.trim() || null,
        status,
        assignedOn: asDate(today),
        dueOn: asDate(dto.dueOn),
        campusId: s.campusId,
        sectionId: s.id,
        subjectId: dto.subjectId,
        assignedById: user.employeeId,
        assignedByUserId: user.id,
        assignedByName: user.fullName,
        publishedAt: status === 'Open' ? new Date() : null,
      },
    });
    const notified = status === 'Open' ? await this.notifyParents(h, s.label) : 0;
    await this.audit.record({ user, action: 'create', module: 'academics', entityType: 'homework', entityId: h.id, campusId: s.campusId, description: `${status === 'Draft' ? 'Drafted' : 'Set'} homework "${h.title}" for ${s.label}, due ${dto.dueOn}`, req });
    return ok({ id: h.id, notified }, status === 'Draft' ? 'Homework saved as a draft' : `Homework set — ${notified} parent notification${notified === 1 ? '' : 's'} queued`);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @RequirePermissions('academics.manage')
  async publish(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { h, label } = await this.load(id, user);
    if (h.status !== 'Draft') throw badRequest('Only draft homework can be published');
    const today = schoolToday();
    if (dayKey(h.dueOn) < today) throw badRequest('The due date has passed. Set the homework again with a new due date.');
    const updated = await this.prisma.homework.update({ where: { id }, data: { status: 'Open', assignedOn: asDate(today), publishedAt: new Date() } });
    const notified = await this.notifyParents(updated, label);
    await this.audit.record({ user, action: 'publish', module: 'academics', entityType: 'homework', entityId: id, campusId: h.campusId, description: `Published homework "${h.title}" for ${label}`, req });
    return ok({ id, notified }, `Homework published — ${notified} parent notification${notified === 1 ? '' : 's'} queued`);
  }

  @Post(':id/remind')
  @HttpCode(200)
  @RequirePermissions('academics.manage')
  async remind(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { h, label } = await this.load(id, user);
    if (h.status !== 'Open') throw badRequest('Reminders are sent for open homework only');
    const submitted = new Set((await this.prisma.homeworkSubmission.findMany({ where: { homeworkId: id }, select: { studentId: true } })).map((x) => x.studentId));
    const pending = (await this.prisma.student.findMany({ where: { sectionId: h.sectionId, status: 'active' }, select: { id: true, firstName: true } })).filter((s) => !submitted.has(s.id));
    if (!pending.length) throw badRequest('Every student has submitted this homework');
    const subject = (await this.access.subjectNames([h.subjectId])).get(h.subjectId) ?? '';
    const due = dayKey(h.dueOn);
    for (const st of pending) {
      await this.notifications.notifyGuardians(st.id, {
        category: 'Attention', topic: 'homework', module: 'academics', campusId: h.campusId, deliver: true,
        title: `Reminder: ${st.firstName} has not submitted "${h.title}"`,
        body: `${subject} homework for ${label}, due ${due === schoolToday() ? 'today' : shortDate(due)}.`,
        route: '/parent-360?tab=academics',
      });
    }
    await this.prisma.homework.update({ where: { id }, data: { lastRemindedAt: new Date() } });
    await this.audit.record({ user, action: 'update', module: 'academics', entityType: 'homework', entityId: id, campusId: h.campusId, description: `Sent a homework reminder for "${h.title}" to parents of ${pending.length} students`, req });
    return ok({ students: pending.length }, `Reminder sent to parents of ${pending.length} student${pending.length === 1 ? '' : 's'}`);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermissions('academics.manage')
  async close(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { h, label } = await this.load(id, user);
    if (h.status !== 'Open') throw badRequest('Only open homework can be closed');
    await this.prisma.homework.update({ where: { id }, data: { status: 'Closed', closedAt: new Date() } });
    const submitted = await this.prisma.homeworkSubmission.count({ where: { homeworkId: id } });
    await this.audit.record({ user, action: 'update', module: 'academics', entityType: 'homework', entityId: id, campusId: h.campusId, description: `Closed homework "${h.title}" for ${label} (${submitted} submitted)`, req });
    return ok({ id }, `"${h.title}" closed`);
  }

  @Get(':id/submissions')
  @RequirePermissions('academics.read')
  async submissions(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const { h } = await this.load(id, user);
    const full = await this.prisma.homework.findUniqueOrThrow({ where: { id }, include: { _count: { select: { submissions: true } } } });
    const [row] = await this.rows([full]);
    const [students, subs] = await Promise.all([
      this.prisma.student.findMany({ where: { sectionId: h.sectionId, status: 'active' }, orderBy: [{ rollNo: 'asc' }, { fullName: 'asc' }], select: { id: true, admissionNo: true, fullName: true, rollNo: true } }),
      this.prisma.homeworkSubmission.findMany({ where: { homeworkId: id } }),
    ]);
    const byStudent = new Map(subs.map((s) => [s.studentId, s]));
    return {
      homework: row,
      students: students.map((s) => {
        const sub = byStudent.get(s.id);
        return { id: s.id, admissionNo: s.admissionNo, fullName: s.fullName, roll: s.rollNo, status: sub?.status ?? null, submittedAt: iso(sub?.submittedAt), feedback: sub?.feedback ?? null };
      }),
    };
  }

  @Put(':id/submissions')
  @RequirePermissions('academics.manage')
  async setSubmission(@Param('id') id: string, @Body() dto: SubmissionDto, @CurrentUser() user: AuthUser) {
    const { h } = await this.load(id, user);
    if (h.status === 'Draft') throw badRequest('Publish the homework before recording submissions');
    const st = await this.prisma.student.findFirst({ where: { id: dto.studentId, sectionId: h.sectionId } });
    if (!st) throw badRequest('This student is not in the class');
    if (dto.status === 'Missing') {
      await this.prisma.homeworkSubmission.deleteMany({ where: { homeworkId: id, studentId: dto.studentId } });
      return ok({ status: null }, 'Marked as not submitted');
    }
    await this.prisma.homeworkSubmission.upsert({
      where: { homeworkId_studentId: { homeworkId: id, studentId: dto.studentId } },
      create: { homeworkId: id, studentId: dto.studentId, status: dto.status, feedback: dto.feedback?.trim() || null, updatedById: user.id },
      update: { status: dto.status, updatedById: user.id, ...(dto.feedback !== undefined ? { feedback: dto.feedback.trim() || null } : {}) },
    });
    return ok({ status: dto.status }, `${st.fullName}: ${dto.status}`);
  }

  // ---------------------------------------------------------------------------

  private async load(id: string, user: AuthUser) {
    const h = await this.prisma.homework.findUnique({ where: { id } });
    if (!h) throw notFound('Homework');
    if (!(await this.access.canSeeSection(user, h.sectionId, h.campusId))) throw forbidden('This homework is outside your classes');
    const label = (await this.access.sectionInfo([h.sectionId])).get(h.sectionId)?.label ?? '';
    return { h, label };
  }

  /** Tells the parents of every student in the class; returns the number of parent notifications. */
  private async notifyParents(h: Homework, label: string): Promise<number> {
    const students = await this.prisma.student.findMany({ where: { sectionId: h.sectionId, status: 'active' }, select: { id: true } });
    const guardians = await this.access.guardianUsers(students.map((s) => s.id));
    const subject = (await this.access.subjectNames([h.subjectId])).get(h.subjectId) ?? 'Homework';
    const ids = [...new Set([...guardians.values()].flat())];
    await this.notifications.notifyUsers(ids, {
      category: 'Information', topic: 'homework', module: 'academics', campusId: h.campusId, deliver: true,
      title: `New ${subject} homework for ${label}: ${h.title}`,
      body: `Due ${shortDate(dayKey(h.dueOn))}.${h.instructions ? ` ${h.instructions.slice(0, 200)}` : ''}`,
      route: '/parent-360?tab=academics',
    });
    return ids.length;
  }
}
