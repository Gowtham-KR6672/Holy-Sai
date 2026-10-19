import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { InnovationIdea, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, conflict, fieldError, notFound } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AREAS, InnovationService, MENTOR_CHOICES, REVIEW_DAYS, addDays, asDate, daysBetween, dayStr, sortRows, todayStr, type StudentInfo,
} from './innovation.util';

class IdeaQuery extends ListQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() category?: string;
}

export class OwnIdeaDto {
  @IsString() @MinLength(4, { message: 'Give the idea a short title' }) @MaxLength(160) title: string;
  @IsString() @MinLength(10, { message: 'Describe it in a sentence or two' }) @MaxLength(1000) problem: string;
  @IsIn(AREAS, { message: 'Choose an area' }) category: string;
  @IsOptional() @IsIn(MENTOR_CHOICES) wantsMentor?: string;
}

class IdeaDto extends OwnIdeaDto {
  @IsUUID('all', { message: 'Choose the student' }) studentId: string;
}

class ReviewDto {
  @IsIn(['start', 'accept', 'decline'], { message: 'Choose start, accept or decline' }) action: 'start' | 'accept' | 'decline';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class MilestoneDraftDto {
  @IsString() @MinLength(3, { message: 'Milestone title is too short' }) @MaxLength(160) title: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use a valid date' }) dueOn?: string | null;
}

class ConvertDto {
  @IsUUID('all', { message: 'Choose a mentor' }) mentorId: string;
  @IsString() @MinLength(2, { message: 'Title is required' }) @MaxLength(160) title: string;
  @IsOptional() @IsString() @MaxLength(1000) summary?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => MilestoneDraftDto) milestones?: MilestoneDraftDto[];
}

const OPEN = ['Submitted', 'Under Review', 'Accepted'];

/** Ideas: submission (staff on behalf of a student, or the student from the portal), teacher review and conversion to a project. */
@Controller('innovation')
export class IdeasController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lab: InnovationService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly counters: CountersService,
  ) {}

  @Get('ideas')
  @RequirePermissions('innovation.read', 'innovation.manage')
  async list(@Query() q: IdeaQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const scope = await this.lab.studentScope(user, q.campusId);
    const and: Prisma.InnovationIdeaWhereInput[] = [this.lab.byStudent(scope)];
    if (q.status === 'open') and.push({ status: { in: OPEN } });
    else if (q.status) and.push({ status: q.status });
    if (q.category) and.push({ category: q.category });
    if (q.q?.trim()) {
      const ids = await this.lab.matchingStudentIds(q.q);
      const term = { contains: q.q.trim(), mode: 'insensitive' as const };
      and.push({ OR: [{ title: term }, { problem: term }, { category: term }, ...(ids.length ? [{ studentId: { in: ids } }] : [])] });
    }
    const where: Prisma.InnovationIdeaWhereInput = { AND: and };
    const dir = q.dir ?? 'desc';
    const sort = q.sort ?? 'submitted';
    const today = todayStr();

    if (sort === 'student') {
      const all = await this.prisma.innovationIdea.findMany({ where, include: { project: { select: { code: true } } } });
      const students = await this.lab.students(all.map((i) => i.studentId));
      const rows = sortRows(all.map((i) => this.row(i, students, today)), 'student', dir, { student: (r) => r.studentName });
      return paged(rows.slice(p.skip, p.skip + p.take), all.length, p);
    }
    const orderBy: Prisma.InnovationIdeaOrderByWithRelationInput[] =
      sort === 'title' ? [{ title: dir }]
        : sort === 'category' ? [{ category: dir }, { submittedOn: 'desc' }]
          : sort === 'status' ? [{ status: dir }, { submittedOn: 'desc' }]
            : [{ submittedOn: dir }, { createdAt: dir }];
    const [rows, total] = await Promise.all([
      this.prisma.innovationIdea.findMany({ where, orderBy, skip: p.skip, take: p.take, include: { project: { select: { code: true } } } }),
      this.prisma.innovationIdea.count({ where }),
    ]);
    const students = await this.lab.students(rows.map((i) => i.studentId));
    return paged(rows.map((i) => this.row(i, students, today)), total, p);
  }

  @Get('ideas/summary')
  @RequirePermissions('innovation.read', 'innovation.manage')
  async summary(@Query() q: ListQuery, @CurrentUser() user: AuthUser) {
    const scope = await this.lab.studentScope(user, q.campusId);
    const where = this.lab.byStudent(scope);
    const cutoff = asDate(addDays(todayStr(), -REVIEW_DAYS));
    const [groups, overdueReview] = await Promise.all([
      this.prisma.innovationIdea.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.innovationIdea.count({ where: { ...where, status: 'Submitted', submittedOn: { lt: cutoff } } }),
    ]);
    const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    return {
      total: groups.reduce((a, g) => a + g._count._all, 0),
      submitted: n('Submitted'),
      underReview: n('Under Review'),
      accepted: n('Accepted'),
      converted: n('Converted'),
      declined: n('Declined'),
      overdueReview,
    };
  }

  @Post('ideas')
  @RequirePermissions('innovation.manage')
  async create(@Body() dto: IdeaDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const student = await this.lab.assertStudent(user, dto.studentId);
    if (student.status !== 'active') throw fieldError('studentId', `${student.fullName} is not an active student`);
    const idea = await this.lab.submitIdea(dto, student, user, 'staff', req);
    return ok({ id: idea.id, status: idea.status }, 'Idea submitted for review');
  }

  @Post('ideas/:id/review')
  @RequirePermissions('innovation.manage')
  async review(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const idea = await this.prisma.innovationIdea.findUnique({ where: { id } });
    if (!idea) throw notFound('Idea');
    await this.lab.assertStudent(user, idea.studentId);
    const note = dto.note?.trim() || null;
    const now = new Date();

    if (dto.action === 'start') {
      if (idea.status !== 'Submitted') throw badRequest(`This idea is already ${idea.status.toLowerCase()}`);
      await this.prisma.innovationIdea.update({
        where: { id },
        data: { status: 'Under Review', reviewedById: user.id, reviewedByName: user.fullName, reviewStartedAt: now, ...(note ? { reviewNote: note } : {}) },
      });
      await this.audit.record({ user, action: 'update', module: 'innovation', entityType: 'innovation_idea', entityId: id, description: `Started reviewing idea "${idea.title}"`, req });
      await this.lab.notifyStudent(idea.studentId, {
        category: 'Information', topic: 'innovation', module: 'innovation', icon: 'lightbulb',
        title: 'Your idea is being reviewed', body: `${user.fullName} is reading "${idea.title}".`, route: '/my-ideas',
      }, false);
      return ok({ status: 'Under Review' }, 'Review started');
    }

    if (idea.status !== 'Submitted' && idea.status !== 'Under Review') throw badRequest(`This idea is already ${idea.status.toLowerCase()}`);
    if (dto.action === 'decline' && !note) throw fieldError('note', 'Tell the student why');
    const status = dto.action === 'accept' ? 'Accepted' : 'Declined';
    await this.prisma.innovationIdea.update({
      where: { id },
      data: {
        status, reviewedById: user.id, reviewedByName: user.fullName, decidedAt: now, reviewNote: note ?? idea.reviewNote,
        reviewStartedAt: idea.reviewStartedAt ?? now,
      },
    });
    await this.notifications.completeTasksFor('innovation_idea', id);
    await this.audit.record({
      user, action: dto.action === 'accept' ? 'approve' : 'reject', module: 'innovation', entityType: 'innovation_idea', entityId: id,
      description: `${status} idea "${idea.title}"${note ? ` — ${note}` : ''}`, req,
    });
    await this.lab.notifyStudent(idea.studentId, dto.action === 'accept'
      ? {
        category: 'Completed', topic: 'innovation', module: 'innovation', icon: 'lightbulb', title: 'Idea accepted',
        body: `"${idea.title}" was accepted by ${user.fullName}. A mentor will be assigned so the project can start.${note ? `\n${note}` : ''}`, route: '/my-ideas', deliver: true,
      }
      : {
        category: 'Information', topic: 'innovation', module: 'innovation', icon: 'lightbulb', title: 'Idea not taken forward',
        body: `"${idea.title}" was not taken forward this time. ${user.fullName}: ${note}`, route: '/my-ideas', deliver: true,
      });
    return ok({ status }, dto.action === 'accept' ? 'Idea accepted' : 'Idea declined');
  }

  @Post('ideas/:id/convert')
  @RequirePermissions('innovation.manage')
  async convert(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConvertDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const idea = await this.prisma.innovationIdea.findUnique({ where: { id }, include: { project: { select: { code: true } } } });
    if (!idea) throw notFound('Idea');
    if (idea.projectId) throw conflict(`This idea is already project ${idea.project?.code ?? ''}`.trim());
    if (idea.status !== 'Accepted') throw badRequest(idea.status === 'Declined' ? 'A declined idea cannot become a project' : 'Accept the idea before converting it to a project');
    const student = await this.lab.assertStudent(user, idea.studentId);
    const mentor = await this.lab.assertMentor(dto.mentorId);
    const title = dto.title.trim();
    if (title.length < 2) throw fieldError('title', 'Title is required');

    const code = await this.counters.reference('IP', 'innovation-projects', 3);
    const today = todayStr();
    const project = await this.prisma.$transaction(async (tx) => {
      const created = await tx.innovationProject.create({
        data: {
          code, title, summary: dto.summary?.trim() || null, stage: 3, status: 'Active', studentId: idea.studentId, campusId: student.campusId,
          mentorId: mentor.id, startedOn: asDate(today), createdById: user.id,
          members: { create: [{ studentId: idea.studentId, role: 'Lead', addedById: user.id }] },
          milestones: { create: (dto.milestones ?? []).map((m, i) => ({ sequence: i + 1, title: m.title.trim(), dueOn: m.dueOn ? asDate(m.dueOn) : null })) },
        },
      });
      await tx.innovationIdea.update({ where: { id }, data: { status: 'Converted', projectId: created.id, decidedAt: idea.decidedAt ?? new Date() } });
      return created;
    });
    await this.notifications.completeTasksFor('innovation_idea', id);
    await this.audit.record({
      user, action: 'create', module: 'innovation', entityType: 'innovation_project', entityId: project.id,
      description: `Converted idea "${idea.title}" to project ${code} with mentor ${mentor.fullName}`, req,
    });
    await this.lab.notifyEmployee(mentor.id, {
      category: 'Attention', topic: 'innovation', module: 'innovation', icon: 'rocket', title: `You are mentoring ${code}`,
      body: `${title} — lead student ${student.fullName}.`, route: `/projects/${project.id}`, campusId: student.campusId,
    });
    await this.lab.notifyStudent(idea.studentId, {
      category: 'Completed', topic: 'innovation', module: 'innovation', icon: 'rocket', title: `Your idea became project ${code}`,
      body: `"${title}" is now a project with ${mentor.fullName} as mentor.`, route: '/my-ideas', deliver: true,
    });
    return ok({ id: project.id, code }, `Project ${code} created`);
  }

  row(i: InnovationIdea & { project: { code: string } | null }, students: Map<string, StudentInfo>, today: string) {
    const st = students.get(i.studentId);
    return {
      id: i.id,
      title: i.title,
      problem: i.problem,
      category: i.category,
      status: i.status,
      submittedOn: dayStr(i.submittedOn)!,
      ageDays: Math.max(0, daysBetween(dayStr(i.submittedOn)!, today)),
      reviewedBy: i.reviewedByName,
      projectId: i.projectId,
      projectCode: i.project?.code ?? null,
      studentId: i.studentId,
      studentName: st?.fullName ?? 'Unknown student',
      admissionNo: st?.admissionNo ?? '',
      grade: st?.grade ?? null,
      section: st?.section ?? null,
    };
  }
}

/** Student portal: the signed-in student's own ideas. The student comes from the access token, never the request. */
@Controller('me')
@RequirePermissions('student_portal.use')
export class MyIdeasController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lab: InnovationService,
  ) {}

  @Get('ideas')
  async list(@CurrentUser() user: AuthUser) {
    if (!user.studentId) return [];
    const rows = await this.prisma.innovationIdea.findMany({
      where: { studentId: user.studentId },
      orderBy: [{ submittedOn: 'desc' }, { createdAt: 'desc' }],
      include: { project: { select: { code: true, stage: true } } },
    });
    const today = todayStr();
    return rows.map((i) => ({
      id: i.id,
      title: i.title,
      problem: i.problem,
      category: i.category,
      status: i.status,
      submittedOn: dayStr(i.submittedOn)!,
      reviewedBy: i.reviewedByName,
      ageDays: Math.max(0, daysBetween(dayStr(i.submittedOn)!, today)),
      projectId: i.projectId,
      projectCode: i.project?.code ?? null,
      projectStage: i.project?.stage ?? null,
    }));
  }

  @Post('ideas')
  async create(@Body() dto: OwnIdeaDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!user.studentId) throw badRequest('No student record is linked to this account');
    const student = await this.prisma.student.findUnique({ where: { id: user.studentId }, select: { id: true, campusId: true, fullName: true, status: true } });
    if (!student) throw badRequest('No student record is linked to this account');
    const idea = await this.lab.submitIdea(dto, student, user, 'student', req);
    return ok({ id: idea.id, status: idea.status }, 'Idea submitted — a teacher will review it');
  }
}
