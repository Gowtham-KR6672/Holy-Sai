import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, conflict, fieldError, notFound } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MilestoneDraftDto } from './ideas.controller';
import {
  ACHIEVEMENT_STAGE, EVIDENCE_KINDS, InnovationService, LEVELS, MEMBER_ROLES, PLACED_RE, PROJECT_LIST_INCLUDE, STAGES, asDate, dayStr,
  milestoneStatuses, sortRows, todayStr,
} from './innovation.util';

class ProjectQuery extends ListQuery {
  @IsOptional() @IsString() stage?: string;
  /** "true" = active, "false" = completed. */
  @IsOptional() @IsString() active?: string;
}

class CreateProjectDto {
  @IsString() @MinLength(4, { message: 'Title is too short' }) @MaxLength(160) title: string;
  @IsOptional() @IsString() @MaxLength(1000) summary?: string | null;
  @IsUUID('all', { message: 'Choose the lead student' }) leadStudentId: string;
  @IsUUID('all', { message: 'Choose a mentor' }) mentorId: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) stage?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) memberIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => MilestoneDraftDto) milestones?: MilestoneDraftDto[];
}

class UpdateProjectDto {
  @IsOptional() @IsString() @MinLength(2, { message: 'Title is required' }) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(1000) summary?: string | null;
  @IsOptional() @IsUUID('all', { message: 'Choose a mentor' }) mentorId?: string;
}

class AdvanceDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
  @IsOptional() @IsString() @MaxLength(160) achievementTitle?: string;
  @IsOptional() @IsIn(LEVELS, { message: 'Choose a level' }) level?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use a valid date' }) achievedOn?: string;
}

class EvidenceDto {
  @IsString() @MinLength(1, { message: 'Title is required' }) @MaxLength(160) title: string;
  @IsIn(EVIDENCE_KINDS, { message: 'Choose a type' }) kind: string;
  @IsOptional() @IsString() @MaxLength(500) link?: string | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
  @IsOptional() @IsUUID('all', { message: 'Choose a milestone' }) milestoneId?: string | null;
}

class FeedbackDto {
  @IsString() @MinLength(5, { message: 'Write at least a sentence' }) @MaxLength(2000) body: string;
}

class MemberDto {
  @IsUUID('all', { message: 'Choose a student' }) studentId: string;
  @IsOptional() @IsIn(MEMBER_ROLES, { message: 'Choose a role' }) role?: string;
}

class NewMilestoneDto {
  @IsString() @MinLength(3, { message: 'Title is too short' }) @MaxLength(160) title: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use a valid date' }) dueOn?: string | null;
}

const topic = { topic: 'innovation', module: 'innovation' } as const;

/** Projects: gallery, record, stage changes, team, evidence and mentor feedback. */
@Controller('innovation')
export class ProjectsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lab: InnovationService,
    private readonly audit: AuditService,
    private readonly counters: CountersService,
  ) {}

  @Get('projects')
  @RequirePermissions('innovation.read', 'innovation.manage')
  async list(@Query() q: ProjectQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q, 12);
    const scope = await this.lab.studentScope(user, q.campusId);
    const and: Prisma.InnovationProjectWhereInput[] = [this.lab.projectWhere(user, scope)];
    if (q.stage !== undefined && q.stage !== '' && !Number.isNaN(Number(q.stage))) and.push({ stage: Number(q.stage) });
    if (q.active === 'true') and.push({ status: 'Active' });
    else if (q.active === 'false') and.push({ status: 'Completed' });
    if (q.q?.trim()) {
      const ids = await this.lab.matchingStudentIds(q.q);
      const term = { contains: q.q.trim(), mode: 'insensitive' as const };
      and.push({
        OR: [{ title: term }, { code: term }, { summary: term }, ...(ids.length ? [{ studentId: { in: ids } }, { members: { some: { studentId: { in: ids } } } }] : [])],
      });
    }
    const projects = await this.prisma.innovationProject.findMany({ where: { AND: and }, include: PROJECT_LIST_INCLUDE });
    const rows = await this.lab.projectRows(projects);
    const sort = q.sort ?? 'updated';
    const dir = q.dir ?? (sort === 'title' || sort === 'student' ? 'asc' : 'desc');
    const sorted = sortRows(rows, ['updated', 'stage', 'progress', 'title', 'student'].includes(sort) ? sort : 'updated', dir, {
      updated: (r) => r.updatedAt,
      stage: (r) => r.stage,
      progress: (r) => (r.milestones ? r.done / r.milestones : 0),
      title: (r) => r.title,
      student: (r) => r.studentName,
    });
    return paged(sorted.slice(p.skip, p.skip + p.take), sorted.length, p);
  }

  @Post('projects')
  @RequirePermissions('innovation.manage')
  async create(@Body() dto: CreateProjectDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const lead = await this.lab.assertStudent(user, dto.leadStudentId, 'leadStudentId');
    if (lead.status !== 'active') throw fieldError('leadStudentId', `${lead.fullName} is not an active student`);
    const mentor = await this.lab.assertMentor(dto.mentorId);
    const memberIds = [...new Set(dto.memberIds ?? [])].filter((id) => id !== lead.id);
    for (const id of memberIds) await this.lab.assertStudent(user, id, 'memberIds');
    const stage = dto.stage ?? 3;
    const code = await this.counters.reference('IP', 'innovation-projects', 3);
    const project = await this.prisma.innovationProject.create({
      data: {
        code, title: dto.title.trim(), summary: dto.summary?.trim() || null, stage, status: 'Active', studentId: lead.id, campusId: lead.campusId,
        mentorId: mentor.id, startedOn: asDate(todayStr()), createdById: user.id,
        members: { create: [{ studentId: lead.id, role: 'Lead', addedById: user.id }, ...memberIds.map((studentId) => ({ studentId, role: 'Member', addedById: user.id }))] },
        milestones: { create: (dto.milestones ?? []).map((m, i) => ({ sequence: i + 1, title: m.title.trim(), dueOn: m.dueOn ? asDate(m.dueOn) : null })) },
      },
    });
    await this.audit.record({
      user, action: 'create', module: 'innovation', entityType: 'innovation_project', entityId: project.id, campusId: lead.campusId,
      description: `Created project ${code} "${project.title}" (lead ${lead.fullName}, mentor ${mentor.fullName}, stage ${STAGES[stage]})`, req,
    });
    await this.lab.notifyEmployee(mentor.id, {
      ...topic, category: 'Attention', icon: 'rocket', title: `You are mentoring ${code}`, body: `${project.title} — lead student ${lead.fullName}.`,
      route: `/projects/${project.id}`, campusId: lead.campusId,
    });
    for (const sid of [lead.id, ...memberIds]) {
      await this.lab.notifyStudent(sid, {
        ...topic, category: 'Information', icon: 'rocket', title: `Innovation Lab project ${code}`,
        body: `You are on the team for "${project.title}" with ${mentor.fullName} as mentor.`,
      }, false);
    }
    return ok({ id: project.id, code }, `Project ${code} created`);
  }

  @Get('projects/:id')
  @RequirePermissions('innovation.read', 'innovation.manage')
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    await this.lab.assertProject(user, id);
    const p = await this.prisma.innovationProject.findUniqueOrThrow({
      where: { id },
      include: {
        idea: { select: { title: true, submittedOn: true } },
        members: { orderBy: { createdAt: 'asc' } },
        milestones: { orderBy: { sequence: 'asc' } },
        evidence: { orderBy: { createdAt: 'desc' }, include: { milestone: { select: { title: true } } } },
        feedback: { orderBy: { createdAt: 'desc' } },
        competitions: { include: { competition: true } },
      },
    });
    const today = todayStr();
    const [students, mentors, campuses, achievements] = await Promise.all([
      this.lab.students([p.studentId, ...p.members.map((m) => m.studentId)]),
      this.lab.employees([p.mentorId]),
      this.lab.campusNames(),
      this.prisma.innovationAchievement.findMany({ where: { projectId: id }, orderBy: { achievedOn: 'desc' } }),
    ]);
    const statuses = milestoneStatuses(p.status === 'Active', p.milestones, today);
    const lead = students.get(p.studentId);
    const mentor = p.mentorId ? mentors.get(p.mentorId) : undefined;
    const members = [...p.members].sort((a, b) => (a.role === 'Lead' ? -1 : b.role === 'Lead' ? 1 : a.createdAt.getTime() - b.createdAt.getTime()));
    return {
      id: p.id,
      code: p.code,
      title: p.title,
      summary: p.summary,
      stage: p.stage,
      status: p.status,
      startedOn: dayStr(p.startedOn),
      updatedAt: p.updatedAt.toISOString(),
      mentorId: p.mentorId,
      mentor: mentor?.fullName ?? null,
      mentorRole: mentor?.designation ?? null,
      ideaTitle: p.idea?.title ?? null,
      ideaSubmittedOn: dayStr(p.idea?.submittedOn ?? null),
      studentId: p.studentId,
      studentName: lead?.fullName ?? 'Unknown student',
      admissionNo: lead?.admissionNo ?? '',
      grade: lead?.grade ?? null,
      section: lead?.section ?? null,
      campusName: campuses.get(p.campusId) ?? '',
      members: members.map((m) => {
        const st = students.get(m.studentId);
        return {
          role: m.role,
          studentId: m.studentId,
          studentName: st?.fullName ?? 'Unknown student',
          admissionNo: st?.admissionNo ?? '',
          grade: st?.grade ?? null,
          section: st?.section ?? null,
        };
      }),
      milestones: p.milestones.map((m) => ({
        id: m.id,
        sequence: m.sequence,
        title: m.title,
        dueOn: dayStr(m.dueOn),
        completedOn: dayStr(m.completedOn),
        evidence: m.evidence,
        feedback: m.feedback,
        status: statuses.get(m.id) ?? 'Pending',
      })),
      evidence: p.evidence.map((e) => ({
        id: e.id,
        title: e.title,
        kind: e.kind,
        link: e.link,
        note: e.note,
        createdAt: e.createdAt.toISOString(),
        addedBy: e.addedByName,
        milestone: e.milestone?.title ?? null,
      })),
      feedback: p.feedback.map((f) => ({ id: f.id, author: f.authorName, authorRole: f.authorRole, body: f.body, createdAt: f.createdAt.toISOString() })),
      competitions: [...p.competitions]
        .sort((a, b) => b.competition.heldOn.getTime() - a.competition.heldOn.getTime())
        .map((e) => ({
          id: e.competition.id,
          name: e.competition.name,
          level: e.competition.level,
          heldOn: dayStr(e.competition.heldOn)!,
          result: e.result ?? e.competition.result ?? null,
        })),
      achievements: achievements.map((a) => ({ id: a.id, title: a.title, type: a.type, level: a.level, achievedOn: dayStr(a.achievedOn)!, verified: a.verified })),
    };
  }

  @Patch('projects/:id')
  @RequirePermissions('innovation.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProjectDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const project = await this.lab.assertProject(user, id);
    const data: Prisma.InnovationProjectUpdateInput = {};
    const notes: string[] = [];
    if (dto.title !== undefined && dto.title.trim() !== project.title) {
      if (dto.title.trim().length < 2) throw fieldError('title', 'Title is required');
      data.title = dto.title.trim();
      notes.push(`title "${data.title}"`);
    }
    if (dto.summary !== undefined && (dto.summary?.trim() || null) !== project.summary) {
      data.summary = dto.summary?.trim() || null;
      notes.push('summary');
    }
    let newMentor: { id: string; fullName: string } | null = null;
    if (dto.mentorId && dto.mentorId !== project.mentorId) {
      newMentor = await this.lab.assertMentor(dto.mentorId, project.mentorId);
      data.mentorId = newMentor.id;
      notes.push(`mentor ${newMentor.fullName}`);
    }
    if (!notes.length) return ok({ id }, 'Project updated');
    await this.prisma.innovationProject.update({ where: { id }, data });
    await this.audit.record({
      user, action: 'update', module: 'innovation', entityType: 'innovation_project', entityId: id, campusId: project.campusId,
      description: `Updated project ${project.code}: ${notes.join(', ')}`, req,
    });
    if (newMentor) {
      await this.lab.notifyEmployee(newMentor.id, {
        ...topic, category: 'Attention', icon: 'rocket', title: `You are mentoring ${project.code}`, body: data.title ? String(data.title) : project.title,
        route: `/projects/${id}`, campusId: project.campusId,
      });
    }
    return ok({ id }, 'Project updated');
  }

  @Post('projects/:id/advance')
  @RequirePermissions('innovation.manage')
  async advance(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdvanceDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const project = await this.lab.assertProject(user, id);
    if (project.stage >= ACHIEVEMENT_STAGE) throw badRequest('This project is already complete');
    const next = project.stage + 1;
    const note = dto.note?.trim() || null;

    if (next < ACHIEVEMENT_STAGE) {
      await this.prisma.innovationProject.update({ where: { id }, data: { stage: next } });
      await this.audit.record({
        user, action: 'update', module: 'innovation', entityType: 'innovation_project', entityId: id, campusId: project.campusId,
        description: `Moved project ${project.code} from ${STAGES[project.stage]} to ${STAGES[next]}${note ? ` — ${note}` : ''}`,
        metadata: { from: project.stage, to: next, note }, req,
      });
      await this.lab.notifyStudent(project.studentId, {
        ...topic, category: 'Information', icon: 'rocket', title: `${project.code} moved to ${STAGES[next]}`, body: project.title,
      }, false);
      return ok({ stage: next }, `Moved to ${STAGES[next]}`);
    }

    // Final stage: record a verified achievement on the lead student's profile.
    const title = dto.achievementTitle?.trim() ?? '';
    if (!title) throw fieldError('achievementTitle', 'Achievement is required');
    if (title.length < 6) throw fieldError('achievementTitle', 'Describe the achievement');
    if (!dto.achievedOn) throw fieldError('achievedOn', 'Date is required');
    const today = todayStr();
    if (dto.achievedOn > today) throw fieldError('achievedOn', 'Cannot be in the future');
    const entries = await this.prisma.innovationCompetitionEntry.findMany({ where: { projectId: id }, include: { competition: true } });
    const placed = entries
      .filter((e) => PLACED_RE.test(e.result ?? e.competition.result ?? ''))
      .sort((a, b) => b.competition.heldOn.getTime() - a.competition.heldOn.getTime())[0];
    const lead = await this.prisma.student.findUnique({ where: { id: project.studentId }, select: { fullName: true, campusId: true } });
    const now = new Date();
    const achievement = await this.prisma.$transaction(async (tx) => {
      await tx.innovationProject.update({ where: { id }, data: { stage: ACHIEVEMENT_STAGE, status: 'Completed', completedOn: asDate(today) } });
      return tx.innovationAchievement.create({
        data: {
          studentId: project.studentId, campusId: lead?.campusId ?? project.campusId, title, type: placed ? 'Competition' : 'Innovation',
          level: dto.level ?? placed?.competition.level ?? 'School', achievedOn: asDate(dto.achievedOn!), verified: true,
          verifiedById: user.id, verifiedByName: user.fullName, verifiedAt: now, projectId: id, competitionId: placed?.competitionId ?? null,
          note, source: 'innovation', createdById: user.id,
        },
      });
    });
    await this.audit.record({
      user, action: 'approve', module: 'innovation', entityType: 'innovation_project', entityId: id, campusId: project.campusId,
      description: `Completed project ${project.code} and recorded achievement "${title}" for ${lead?.fullName ?? 'the lead student'}`,
      metadata: { achievementId: achievement.id, level: achievement.level }, req,
    });
    await this.lab.notifyStudent(project.studentId, {
      ...topic, category: 'Completed', icon: 'award', title: 'Achievement recorded',
      body: `${lead?.fullName ?? 'Your child'}: ${title} (${achievement.level}). Recorded on the Student 360 profile.`, deliver: true,
    });
    return ok({ stage: ACHIEVEMENT_STAGE, achievementId: achievement.id }, 'Achievement recorded');
  }

  // -- team ------------------------------------------------------------------
  @Post('projects/:id/members')
  @RequirePermissions('innovation.manage')
  async addMember(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MemberDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const project = await this.lab.assertProject(user, id);
    const student = await this.lab.assertStudent(user, dto.studentId);
    if (student.status !== 'active') throw fieldError('studentId', `${student.fullName} is not an active student`);
    const existing = await this.prisma.innovationProjectMember.findUnique({ where: { projectId_studentId: { projectId: id, studentId: dto.studentId } } });
    if (existing) throw conflict(`${student.fullName} is already on the team`);
    const role = dto.role ?? 'Member';
    await this.prisma.innovationProjectMember.create({ data: { projectId: id, studentId: dto.studentId, role, addedById: user.id } });
    await this.lab.touch(id);
    await this.audit.record({
      user, action: 'update', module: 'innovation', entityType: 'innovation_project', entityId: id, campusId: project.campusId,
      description: `Added ${student.fullName} to ${project.code} as ${role}`, req,
    });
    await this.lab.notifyStudent(dto.studentId, {
      ...topic, category: 'Information', icon: 'rocket', title: `You joined ${project.code}`, body: `${project.title} — role: ${role}.`,
    }, false);
    return ok({ studentId: dto.studentId, role }, 'Member added');
  }

  @Delete('projects/:id/members/:studentId')
  @RequirePermissions('innovation.manage')
  async removeMember(@Param('id', ParseUUIDPipe) id: string, @Param('studentId', ParseUUIDPipe) studentId: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const project = await this.lab.assertProject(user, id);
    const member = await this.prisma.innovationProjectMember.findUnique({ where: { projectId_studentId: { projectId: id, studentId } } });
    if (!member) throw notFound('Team member');
    if (member.role === 'Lead' || studentId === project.studentId) throw badRequest('The lead student cannot be removed from the team');
    await this.prisma.innovationProjectMember.delete({ where: { projectId_studentId: { projectId: id, studentId } } });
    await this.lab.touch(id);
    const st = await this.prisma.student.findUnique({ where: { id: studentId }, select: { fullName: true } });
    await this.audit.record({
      user, action: 'update', module: 'innovation', entityType: 'innovation_project', entityId: id, campusId: project.campusId,
      description: `Removed ${st?.fullName ?? 'a student'} from ${project.code}`, req,
    });
    return ok(null, 'Team member removed');
  }

  // -- milestones (create; edit/complete/delete live in the milestones controller) ---------------
  @Post('projects/:id/milestones')
  @RequirePermissions('innovation.manage')
  async addMilestone(@Param('id', ParseUUIDPipe) id: string, @Body() dto: NewMilestoneDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const project = await this.lab.assertProject(user, id);
    const last = await this.prisma.innovationMilestone.aggregate({ where: { projectId: id }, _max: { sequence: true } });
    const m = await this.prisma.innovationMilestone.create({
      data: { projectId: id, sequence: (last._max.sequence ?? 0) + 1, title: dto.title.trim(), dueOn: dto.dueOn ? asDate(dto.dueOn) : null },
    });
    await this.lab.touch(id);
    await this.audit.record({
      user, action: 'create', module: 'innovation', entityType: 'innovation_milestone', entityId: m.id, campusId: project.campusId,
      description: `Added milestone "${m.title}" to ${project.code}${dto.dueOn ? ` (due ${dto.dueOn})` : ''}`, req,
    });
    return ok({ id: m.id }, 'Milestone added');
  }

  // -- evidence --------------------------------------------------------------
  @Post('projects/:id/evidence')
  @RequirePermissions('innovation.manage')
  async addEvidence(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EvidenceDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const project = await this.lab.assertProject(user, id);
    const title = dto.title.trim();
    if (!title) throw fieldError('title', 'Title is required');
    const link = dto.link?.trim() || null;
    if (link && !/^https?:\/\/\S+$/i.test(link)) throw fieldError('link', 'Enter a full http(s) link');
    if (dto.kind === 'Link' && !link) throw fieldError('link', 'Link is required');
    if (dto.milestoneId) {
      const m = await this.prisma.innovationMilestone.findFirst({ where: { id: dto.milestoneId, projectId: id } });
      if (!m) throw fieldError('milestoneId', 'Choose a milestone of this project');
    }
    const e = await this.prisma.innovationEvidence.create({
      data: { projectId: id, milestoneId: dto.milestoneId || null, title, kind: dto.kind, link, note: dto.note?.trim() || null, addedById: user.id, addedByName: user.fullName },
    });
    await this.lab.touch(id);
    await this.audit.record({
      user, action: 'create', module: 'innovation', entityType: 'innovation_evidence', entityId: e.id, campusId: project.campusId,
      description: `Added ${dto.kind.toLowerCase()} evidence "${title}" to ${project.code}`, req,
    });
    return ok({ id: e.id }, 'Evidence added');
  }

  @Delete('evidence/:id')
  @RequirePermissions('innovation.manage')
  async removeEvidence(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.prisma.innovationEvidence.findUnique({ where: { id } });
    if (!e) throw notFound('Evidence');
    const project = await this.lab.assertProject(user, e.projectId);
    await this.prisma.innovationEvidence.delete({ where: { id } });
    await this.lab.touch(e.projectId);
    await this.audit.record({
      user, action: 'delete', module: 'innovation', entityType: 'innovation_evidence', entityId: id, campusId: project.campusId,
      description: `Removed evidence "${e.title}" from ${project.code}`, req,
    });
    return ok(null, 'Evidence removed');
  }

  // -- mentor feedback ---------------------------------------------------------
  @Post('projects/:id/feedback')
  @RequirePermissions('innovation.manage')
  async addFeedback(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FeedbackDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const project = await this.lab.assertProject(user, id);
    const body = dto.body.trim();
    if (body.length < 5) throw fieldError('body', 'Write at least a sentence');
    const emp = user.employeeId ? await this.prisma.employee.findUnique({ where: { id: user.employeeId }, select: { designation: true } }) : null;
    const f = await this.prisma.innovationFeedback.create({
      data: {
        projectId: id, authorId: user.id, authorEmployeeId: user.employeeId, authorName: user.fullName,
        authorRole: project.mentorId && project.mentorId === user.employeeId ? 'Mentor' : (emp?.designation ?? user.roleName), body,
      },
    });
    await this.lab.touch(id);
    await this.audit.record({
      user, action: 'create', module: 'innovation', entityType: 'innovation_feedback', entityId: f.id, campusId: project.campusId,
      description: `Added mentor feedback on ${project.code}`, req,
    });
    if (project.mentorId && project.mentorId !== user.employeeId) {
      await this.lab.notifyEmployee(project.mentorId, {
        ...topic, category: 'Information', icon: 'message', title: `New feedback on ${project.code}`, body: `${user.fullName}: ${body.slice(0, 140)}`,
        route: `/projects/${id}`, campusId: project.campusId,
      });
    }
    return ok({ id: f.id }, 'Feedback added');
  }
}
