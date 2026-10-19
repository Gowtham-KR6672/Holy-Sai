import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, notFound } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InnovationService, asDate, daysBetween, dayStr, milestoneStatuses, sortRows, todayStr } from './innovation.util';

class MilestoneQuery extends ListQuery {
  /** open | Overdue | due_week | In Progress | Pending | Completed (none = all) */
  @IsOptional() @IsString() status?: string;
}

class UpdateMilestoneDto {
  @IsOptional() @IsBoolean() completed?: boolean;
  @IsOptional() @IsString() @MinLength(3, { message: 'Title is too short' }) @MaxLength(160) title?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use a valid date' }) dueOn?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) evidence?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) feedback?: string | null;
}

/** Days ahead that count as "due this week". */
const WEEK = 7;

/** Milestones across the lab: the checkpoint list, its summary, and edit / complete / delete. */
@Controller('innovation')
export class MilestonesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lab: InnovationService,
    private readonly audit: AuditService,
  ) {}

  /** Every milestone of the projects in scope with its derived status. */
  private async rows(user: AuthUser, campusId?: string) {
    const scope = await this.lab.studentScope(user, campusId);
    const projects = await this.prisma.innovationProject.findMany({
      where: this.lab.projectWhere(user, scope),
      select: {
        id: true, code: true, title: true, status: true, studentId: true, mentorId: true,
        milestones: { select: { id: true, sequence: true, title: true, dueOn: true, completedOn: true, createdAt: true } },
      },
    });
    const today = todayStr();
    const [students, mentors] = await Promise.all([
      this.lab.students(projects.map((p) => p.studentId)),
      this.lab.employees(projects.map((p) => p.mentorId)),
    ]);
    return projects.flatMap((p) => {
      const statuses = milestoneStatuses(p.status === 'Active', p.milestones, today);
      const st = students.get(p.studentId);
      return p.milestones.map((m) => {
        const dueOn = dayStr(m.dueOn);
        return {
          id: m.id,
          title: m.title,
          dueOn,
          completedOn: dayStr(m.completedOn),
          status: statuses.get(m.id) ?? 'Pending',
          daysLeft: dueOn ? daysBetween(today, dueOn) : null,
          projectId: p.id,
          projectCode: p.code,
          projectTitle: p.title,
          projectActive: p.status === 'Active',
          mentor: p.mentorId ? (mentors.get(p.mentorId)?.fullName ?? null) : null,
          studentId: p.studentId,
          studentName: st?.fullName ?? 'Unknown student',
          grade: st?.grade ?? null,
          section: st?.section ?? null,
          sequence: m.sequence,
          createdOn: dayStr(m.createdAt)!,
        };
      });
    });
  }

  @Get('milestones')
  @RequirePermissions('innovation.read', 'innovation.manage')
  async list(@Query() q: MilestoneQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    let rows = await this.rows(user, q.campusId);
    const s = q.status;
    if (s === 'open') rows = rows.filter((r) => !r.completedOn && r.projectActive);
    else if (s === 'due_week') rows = rows.filter((r) => !r.completedOn && r.projectActive && r.daysLeft != null && r.daysLeft >= 0 && r.daysLeft <= WEEK);
    else if (s) rows = rows.filter((r) => r.status === s);
    if (q.q?.trim()) {
      const term = q.q.trim().toLowerCase();
      rows = rows.filter((r) => [r.title, r.projectCode, r.projectTitle, r.studentName, r.mentor ?? ''].some((x) => x.toLowerCase().includes(term)));
    }
    const sort = q.sort && ['title', 'student', 'due', 'status', 'project'].includes(q.sort) ? q.sort : 'due';
    const sorted = sortRows(rows, sort, q.dir ?? 'asc', {
      title: (r) => r.title,
      student: (r) => r.studentName,
      due: (r) => r.dueOn,
      status: (r) => r.status,
      project: (r) => r.projectCode,
    });
    const page = sorted.slice(p.skip, p.skip + p.take).map(({ projectActive: _a, sequence: _s, createdOn: _c, ...r }) => r);
    return paged(page, sorted.length, p);
  }

  @Get('milestones/summary')
  @RequirePermissions('innovation.read', 'innovation.manage')
  async summary(@Query() q: ListQuery, @CurrentUser() user: AuthUser) {
    const rows = await this.rows(user, q.campusId);
    const year = await this.lab.yearWindow();
    const inYear = rows.filter((r) => {
      const d = r.dueOn ?? r.createdOn;
      return d >= year.from && d <= year.to;
    });
    return {
      thisYear: inYear.length,
      completed: inYear.filter((r) => r.completedOn).length,
      dueThisWeek: rows.filter((r) => !r.completedOn && r.projectActive && r.daysLeft != null && r.daysLeft >= 0 && r.daysLeft <= WEEK).length,
      overdue: rows.filter((r) => r.status === 'Overdue').length,
    };
  }

  @Patch('milestones/:id')
  @RequirePermissions('innovation.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMilestoneDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const m = await this.prisma.innovationMilestone.findUnique({ where: { id } });
    if (!m) throw notFound('Milestone');
    const project = await this.lab.assertProject(user, m.projectId);
    const data: Prisma.InnovationMilestoneUpdateInput = {};
    const notes: string[] = [];
    let message = 'Milestone updated';

    if (dto.completed !== undefined && dto.completed !== !!m.completedOn) {
      if (dto.completed) {
        data.completedOn = asDate(todayStr());
        data.completedById = user.id;
        notes.push('completed');
        message = 'Milestone completed';
      } else {
        data.completedOn = null;
        data.completedById = null;
        notes.push('reopened');
        message = 'Milestone reopened';
      }
    } else if (dto.completed !== undefined) {
      message = dto.completed ? 'Milestone completed' : 'Milestone reopened';
    }
    if (dto.title !== undefined && dto.title.trim() !== m.title) {
      if (dto.title.trim().length < 3) throw fieldError('title', 'Title is too short');
      data.title = dto.title.trim();
      notes.push(`title "${data.title}"`);
    }
    if (dto.dueOn !== undefined && (dto.dueOn || null) !== dayStr(m.dueOn)) {
      data.dueOn = dto.dueOn ? asDate(dto.dueOn) : null;
      notes.push(dto.dueOn ? `due ${dto.dueOn}` : 'no due date');
    }
    if (dto.evidence !== undefined && (dto.evidence?.trim() || null) !== m.evidence) {
      data.evidence = dto.evidence?.trim() || null;
      notes.push('evidence summary');
    }
    if (dto.feedback !== undefined && (dto.feedback?.trim() || null) !== m.feedback) {
      data.feedback = dto.feedback?.trim() || null;
      notes.push('mentor feedback');
    }
    if (!notes.length) return ok({ id }, message);
    await this.prisma.innovationMilestone.update({ where: { id }, data });
    await this.lab.touch(m.projectId);
    await this.audit.record({
      user, action: 'update', module: 'innovation', entityType: 'innovation_milestone', entityId: id, campusId: project.campusId,
      description: `Milestone "${m.title}" on ${project.code}: ${notes.join(', ')}`, req,
    });
    return ok({ id }, message);
  }

  @Delete('milestones/:id')
  @RequirePermissions('innovation.manage')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const m = await this.prisma.innovationMilestone.findUnique({ where: { id } });
    if (!m) throw notFound('Milestone');
    const project = await this.lab.assertProject(user, m.projectId);
    if (m.completedOn) throw badRequest('A completed milestone cannot be deleted. Reopen it first.');
    await this.prisma.innovationMilestone.delete({ where: { id } });
    await this.lab.touch(m.projectId);
    await this.audit.record({
      user, action: 'delete', module: 'innovation', entityType: 'innovation_milestone', entityId: id, campusId: project.campusId,
      description: `Deleted milestone "${m.title}" from ${project.code}`, req,
    });
    return ok(null, 'Milestone deleted');
  }
}
