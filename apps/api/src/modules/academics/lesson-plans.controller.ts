import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import type { LessonPlan, Prisma } from '@prisma/client';
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
import { addDays, asDate, dayKeyOrNull, iso, schoolToday, weekStart } from './academics.util';

const STATUSES = ['Draft', 'Submitted', 'Under Review', 'Approved', 'Rejected'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class PlanQuery extends ListQuery {
  @IsOptional() @IsIn(STATUSES) status?: string;
  @IsOptional() @IsString() subjectId?: string;
  @IsOptional() @IsString() mine?: string;
}

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class StepDto {
  @IsOptional() @IsString() @MaxLength(40) time: string;
  @IsString() @MinLength(1, { message: 'Every step needs a name' }) @MaxLength(120) step: string;
  @IsOptional() @IsString() @MaxLength(600) detail: string;
}

class DiffDto {
  @IsString() @MaxLength(40) level: string;
  @IsString() @MaxLength(600) detail: string;
}

class ContentDto {
  @IsOptional() @IsString() @MaxLength(1000) objective?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => StepDto) plan?: StepDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) activities?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => DiffDto) differentiation?: DiffDto[];
  @IsOptional() @IsString() @MaxLength(600) homework?: string;
}

class PlanUpdateDto {
  @IsString() @MinLength(3, { message: 'Give the lesson a title' }) @MaxLength(160) title: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID('all', { message: 'Choose an objective' }) objectiveId?: string | null;
  @Matches(DATE, { message: 'Choose a date' }) plannedFor: string;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => ContentDto) content?: ContentDto;
}

class PlanCreateDto extends PlanUpdateDto {
  @IsUUID('all', { message: 'Choose a class' }) sectionId: string;
  @IsUUID('all', { message: 'Choose a subject' }) subjectId: string;
  @IsOptional() @IsBoolean() aiGenerated?: boolean;
  @IsOptional() @IsBoolean() submit?: boolean;
}

class TransitionDto {
  @IsIn(['submit', 'review', 'approve', 'reject', 'reopen'], { message: 'Unknown action' }) action: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

@Controller('academics/lesson-plans')
export class LessonPlansController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademicsAccess,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Teachers see plans for their classes and their own; the academic office sees the campus. */
  private async scopeWhere(user: AuthUser, campusId?: string): Promise<Prisma.LessonPlanWhereInput> {
    const s = await this.access.sectionIdsOrCampus(user, campusId);
    if (s.sectionIds) return { OR: [{ sectionId: { in: s.sectionIds } }, ...(user.employeeId ? [{ authorId: user.employeeId }] : [])] };
    return s.campusId ? { campusId: s.campusId } : {};
  }

  private reviewer(user: AuthUser) {
    return user.permissions.has('academics.manage') && this.access.isSchoolLevel(user);
  }

  private async rows(list: LessonPlan[]) {
    const [sections, subjects, teachers, objectives] = await Promise.all([
      this.access.sectionInfo(list.map((p) => p.sectionId ?? '')),
      this.access.subjectNames(list.map((p) => p.subjectId)),
      this.access.employeeNames(list.map((p) => p.authorId)),
      this.prisma.curriculumObjective.findMany({ where: { id: { in: list.map((p) => p.objectiveId).filter((x): x is string => !!x) } } }),
    ]);
    return list.map((p) => {
      const o = objectives.find((x) => x.id === p.objectiveId);
      return {
        id: p.id,
        title: p.title,
        status: p.status,
        plannedFor: dayKeyOrNull(p.plannedFor),
        aiGenerated: p.aiGenerated,
        sectionId: p.sectionId,
        sectionLabel: p.sectionId ? sections.get(p.sectionId)?.label ?? null : null,
        subjectId: p.subjectId,
        subject: subjects.get(p.subjectId) ?? '',
        objectiveId: p.objectiveId,
        objectiveCode: o?.code ?? null,
        objectiveText: o?.description ?? null,
        authorId: p.authorId,
        teacher: teachers.get(p.authorId) ?? '',
        approvedAt: iso(p.approvedAt),
        approvedBy: p.approvedByName,
        reviewNote: p.reviewNote,
      };
    });
  }

  @Get('summary')
  @RequirePermissions('academics.read')
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const where = await this.scopeWhere(user, q.campusId);
    const ws = weekStart(schoolToday());
    const we = addDays(ws, 6);
    const week = { plannedFor: { gte: asDate(ws), lte: asDate(we) } };
    const [thisWeek, approved, awaitingReview, drafts, total, ai] = await Promise.all([
      this.prisma.lessonPlan.count({ where: { AND: [where, week] } }),
      this.prisma.lessonPlan.count({ where: { AND: [where, week, { status: 'Approved' }] } }),
      this.prisma.lessonPlan.count({ where: { AND: [where, { status: { in: ['Submitted', 'Under Review'] } }] } }),
      this.prisma.lessonPlan.count({ where: { AND: [where, { status: 'Draft' }] } }),
      this.prisma.lessonPlan.count({ where }),
      this.prisma.lessonPlan.count({ where: { AND: [where, { aiGenerated: true }] } }),
    ]);
    return { thisWeek, approved, awaitingReview, drafts, aiAssistedPct: total ? Math.round((100 * ai) / total) : null, weekStart: ws, weekEnd: we };
  }

  @Get()
  @RequirePermissions('academics.read')
  async list(@Query() q: PlanQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const filters: Prisma.LessonPlanWhereInput[] = [await this.scopeWhere(user, q.campusId)];
    if (q.status) filters.push({ status: q.status });
    if (q.subjectId) filters.push({ subjectId: q.subjectId });
    if (q.mine === 'true') filters.push({ authorId: user.employeeId ?? '00000000-0000-0000-0000-000000000000' });
    if (q.q) {
      const [objs, staff] = await Promise.all([
        this.prisma.curriculumObjective.findMany({ where: { OR: [{ code: like(q.q) }, { description: like(q.q) }] }, select: { id: true } }),
        this.prisma.employee.findMany({ where: { fullName: like(q.q) }, select: { id: true } }),
      ]);
      filters.push({ OR: [{ title: like(q.q) }, { objectiveId: { in: objs.map((o) => o.id) } }, { authorId: { in: staff.map((s) => s.id) } }] });
    }
    const where: Prisma.LessonPlanWhereInput = { AND: filters };
    const dir = q.dir ?? 'desc';
    const orderBy: Prisma.LessonPlanOrderByWithRelationInput[] =
      q.sort === 'title' ? [{ title: dir }] : q.sort === 'status' ? [{ status: dir }, { plannedFor: 'desc' }] : q.sort === 'cls' ? [{ sectionId: dir }, { plannedFor: 'desc' }] : q.sort === 'teacher' ? [{ authorId: dir }, { plannedFor: 'desc' }] : [{ plannedFor: dir }, { createdAt: dir }];
    const [list, total] = await Promise.all([
      this.prisma.lessonPlan.findMany({ where, orderBy, skip: p.skip, take: p.take }),
      this.prisma.lessonPlan.count({ where }),
    ]);
    return paged(await this.rows(list), total, p);
  }

  @Get(':id')
  @RequirePermissions('academics.read')
  async detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const p = await this.load(id, user);
    const [row] = await this.rows([p]);
    return { ...row, content: (p.content ?? {}) as Record<string, unknown> };
  }

  @Post()
  @RequirePermissions('academics.manage')
  async create(@Body() dto: PlanCreateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!user.employeeId) throw badRequest('Lesson plans are written by teaching staff. Ask the office to link your account to your staff record.');
    const s = await this.access.assertSection(user, dto.sectionId).catch(() => {
      throw fieldError('sectionId', 'Choose one of your classes');
    });
    if (!(await this.prisma.subject.findUnique({ where: { id: dto.subjectId } }))) throw fieldError('subjectId', 'Choose a subject');
    await this.checkObjective(dto.objectiveId, dto.subjectId);
    if (dto.submit && !(dto.content?.plan ?? []).length) throw fieldError('steps', 'Add at least one lesson step before submitting');
    const status = dto.submit ? 'Submitted' : 'Draft';
    const plan = await this.prisma.lessonPlan.create({
      data: {
        title: dto.title.trim(),
        status,
        plannedFor: asDate(dto.plannedFor),
        aiGenerated: !!dto.aiGenerated,
        campusId: s.campusId,
        sectionId: s.id,
        subjectId: dto.subjectId,
        objectiveId: dto.objectiveId ?? null,
        authorId: user.employeeId,
        content: (dto.content ?? {}) as Prisma.InputJsonValue,
        submittedAt: dto.submit ? new Date() : null,
      },
    });
    if (dto.submit) await this.askForReview(plan, s.label, user);
    await this.audit.record({ user, action: 'create', module: 'academics', entityType: 'lesson_plan', entityId: plan.id, campusId: s.campusId, description: `${dto.submit ? 'Submitted' : 'Drafted'} lesson plan "${plan.title}" for ${s.label}`, req });
    return ok({ id: plan.id, status }, dto.submit ? 'Lesson plan submitted for review' : 'Lesson plan saved as a draft');
  }

  /** Author edits a draft or a returned plan; saving returns it to Draft. */
  @Put(':id')
  @RequirePermissions('academics.manage')
  async update(@Param('id') id: string, @Body() dto: PlanUpdateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const p = await this.load(id, user);
    if (p.authorId !== user.employeeId) throw forbidden('Only the author can edit this lesson plan');
    if (p.status !== 'Draft' && p.status !== 'Rejected') throw badRequest('Plans can be edited only as a draft or after being returned');
    await this.checkObjective(dto.objectiveId, p.subjectId);
    await this.prisma.lessonPlan.update({
      where: { id },
      data: {
        title: dto.title.trim(),
        objectiveId: dto.objectiveId ?? null,
        plannedFor: asDate(dto.plannedFor),
        ...(dto.content ? { content: dto.content as Prisma.InputJsonValue } : {}),
        status: 'Draft',
      },
    });
    await this.audit.record({ user, action: 'update', module: 'academics', entityType: 'lesson_plan', entityId: id, campusId: p.campusId, description: `Edited lesson plan "${dto.title.trim()}"`, req });
    return ok({ id, status: 'Draft' }, 'Lesson plan updated');
  }

  @Delete(':id')
  @RequirePermissions('academics.manage')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const p = await this.load(id, user);
    if (p.authorId !== user.employeeId) throw forbidden('Only the author can delete this lesson plan');
    if (p.status !== 'Draft') throw badRequest('Only drafts can be deleted');
    await this.prisma.lessonPlan.delete({ where: { id } });
    await this.audit.record({ user, action: 'delete', module: 'academics', entityType: 'lesson_plan', entityId: id, campusId: p.campusId, description: `Deleted draft lesson plan "${p.title}"`, req });
    return ok(null, 'Draft deleted');
  }

  /** submit / review / approve / reject / reopen */
  @Post(':id/transition')
  @HttpCode(200)
  @RequirePermissions('academics.manage')
  async transition(@Param('id') id: string, @Body() dto: TransitionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const p = await this.load(id, user);
    const isAuthor = p.authorId === user.employeeId;
    const label = p.sectionId ? (await this.access.sectionInfo([p.sectionId])).get(p.sectionId)?.label ?? '' : '';
    const note = dto.note?.trim() || null;
    const authorUser = async () => (await this.access.usersForEmployees([p.authorId])).get(p.authorId);
    let status: string;
    let message: string;

    switch (dto.action) {
      case 'submit': {
        if (!isAuthor) throw forbidden('Only the author can submit this plan');
        if (p.status !== 'Draft' && p.status !== 'Rejected') throw badRequest(`A plan that is ${p.status.toLowerCase()} cannot be submitted`);
        const steps = ((p.content as { plan?: unknown[] } | null)?.plan ?? []).length;
        if (!steps) throw badRequest('Add at least one lesson step before submitting');
        status = 'Submitted';
        await this.prisma.lessonPlan.update({ where: { id }, data: { status, submittedAt: new Date(), reviewNote: null, approvedAt: null, approvedById: null, approvedByName: null } });
        await this.askForReview(p, label, user);
        message = 'Lesson plan submitted for review';
        break;
      }
      case 'review': {
        if (isAuthor || !this.reviewer(user)) throw forbidden('Only a reviewer from the academic office can review this plan');
        if (p.status !== 'Submitted') throw badRequest('Only submitted plans can be taken into review');
        status = 'Under Review';
        await this.prisma.lessonPlan.update({ where: { id }, data: { status, reviewStartedAt: new Date() } });
        message = 'Review started';
        break;
      }
      case 'approve':
      case 'reject': {
        if (isAuthor || !this.reviewer(user)) throw forbidden('You cannot review your own lesson plan');
        if (p.status !== 'Submitted' && p.status !== 'Under Review') throw badRequest('Only plans awaiting review can be decided');
        if (dto.action === 'reject' && (!note || note.length < 3)) throw fieldError('note', 'Give the author a reason');
        status = dto.action === 'approve' ? 'Approved' : 'Rejected';
        await this.prisma.lessonPlan.update({
          where: { id },
          data: { status, approvedAt: dto.action === 'approve' ? new Date() : null, approvedById: user.id, approvedByName: user.fullName, reviewNote: note },
        });
        await this.notifications.completeTasksFor('lesson_plan', id);
        const author = await authorUser();
        if (author) {
          await this.notifications.notifyUsers([author], {
            category: status === 'Approved' ? 'Completed' : 'Attention', topic: 'system', module: 'academics', campusId: p.campusId,
            title: status === 'Approved' ? `Lesson plan approved: ${p.title}` : `Lesson plan returned: ${p.title}`,
            body: status === 'Approved' ? `Approved by ${user.fullName}${note ? ` — ${note}` : ''}` : `${user.fullName}: ${note}`,
            route: '/lesson-plans',
          });
        }
        message = status === 'Approved' ? 'Lesson plan approved' : 'Lesson plan returned to the author';
        break;
      }
      default: {
        if (!isAuthor) throw forbidden('Only the author can reopen this plan');
        if (p.status !== 'Rejected') throw badRequest('Only returned plans can be reopened');
        status = 'Draft';
        await this.prisma.lessonPlan.update({ where: { id }, data: { status } });
        message = 'Plan reopened as a draft';
      }
    }
    await this.audit.record({
      user,
      action: dto.action === 'approve' ? 'approve' : dto.action === 'reject' ? 'reject' : 'update',
      module: 'academics', entityType: 'lesson_plan', entityId: id, campusId: p.campusId, req,
      description: `Lesson plan "${p.title}"${label ? ` (${label})` : ''}: ${p.status} → ${status}${note ? ` — ${note}` : ''}`,
    });
    return ok({ status }, message);
  }

  // ---------------------------------------------------------------------------

  private async load(id: string, user: AuthUser): Promise<LessonPlan> {
    const p = await this.prisma.lessonPlan.findUnique({ where: { id } });
    if (!p) throw notFound('Lesson plan');
    const own = !!user.employeeId && p.authorId === user.employeeId;
    if (!own && p.sectionId && !(await this.access.canSeeSection(user, p.sectionId, p.campusId))) throw forbidden('This lesson plan is outside your classes');
    if (!own && !p.sectionId && this.access.restricted(user)) throw forbidden('This lesson plan is outside your classes');
    return p;
  }

  private async checkObjective(objectiveId: string | null | undefined, subjectId: string) {
    if (!objectiveId) return;
    const o = await this.prisma.curriculumObjective.findUnique({ where: { id: objectiveId } });
    if (!o || o.subjectId !== subjectId) throw fieldError('objectiveId', 'Choose an objective of this subject');
  }

  /** Review tasks for the academic office of the plan's campus. */
  private async askForReview(p: LessonPlan, label: string, author: AuthUser) {
    const leads = await this.access.schoolLeads(p.campusId, author.id);
    for (const assigneeId of leads) {
      await this.notifications.createTask({
        title: `Review lesson plan: ${p.title}${label ? ` (${label})` : ''}`,
        module: 'Academics', assigneeId, status: 'Under Review', priority: 'Medium',
        dueOn: p.plannedFor && p.plannedFor >= asDate(schoolToday()) ? p.plannedFor : null,
        route: '/lesson-plans?status=Submitted', entityType: 'lesson_plan', entityId: p.id,
      });
    }
    await this.notifications.notifyUsers(leads, {
      category: 'Attention', topic: 'system', module: 'academics', campusId: p.campusId,
      title: `Lesson plan submitted: ${p.title}`, body: `${author.fullName}${label ? ` · ${label}` : ''}`, route: '/lesson-plans?status=Submitted',
    });
  }
}
