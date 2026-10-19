import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, conflict, fieldError, notFound } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InnovationService, LEVELS, PLACED_RE, STAGES, asDate, daysBetween, dayStr, todayStr } from './innovation.util';

class CompetitionQuery extends ListQuery {
  /** upcoming | past */
  @IsOptional() @IsString() when?: string;
}

class CompetitionDto {
  @IsString() @MinLength(2, { message: 'Name is required' }) @MaxLength(160) name: string;
  @IsIn(LEVELS, { message: 'Choose a level' }) level: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date is required' }) heldOn: string;
  @IsOptional() @IsString() @MaxLength(200) result?: string | null;
}

class EntryDto {
  @IsUUID('all', { message: 'Choose a project' }) projectId: string;
}

class EntryResultDto {
  @IsString() @MinLength(1, { message: 'Enter the result' }) @MaxLength(200) result: string;
}

/** Stage a project moves to when it is entered in a competition. */
const COMPETITION_STAGE = 5;

/** Competitions the lab registered for, the projects entered and their results. */
@Controller('innovation')
export class CompetitionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lab: InnovationService,
    private readonly audit: AuditService,
  ) {}

  @Get('competitions')
  @RequirePermissions('innovation.read', 'innovation.manage')
  async list(@Query() q: CompetitionQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const today = todayStr();
    const where: Prisma.InnovationCompetitionWhereInput = {
      ...(q.when === 'upcoming' ? { heldOn: { gte: asDate(today) } } : q.when === 'past' ? { heldOn: { lt: asDate(today) } } : {}),
      ...(q.q?.trim() ? { OR: [{ name: { contains: q.q.trim(), mode: 'insensitive' } }, { level: { contains: q.q.trim(), mode: 'insensitive' } }, { result: { contains: q.q.trim(), mode: 'insensitive' } }] } : {}),
    };
    const order: Prisma.SortOrder = q.when === 'upcoming' ? 'asc' : (q.dir ?? 'desc');
    const [rows, total] = await Promise.all([
      this.prisma.innovationCompetition.findMany({
        where, orderBy: [{ heldOn: order }, { name: 'asc' }], skip: p.skip, take: p.take,
        include: { _count: { select: { entries: true } } },
      }),
      this.prisma.innovationCompetition.count({ where }),
    ]);
    const entries = await this.visibleEntries(user, rows.map((r) => r.id));
    return paged(
      rows.map((c) => ({
        id: c.id,
        name: c.name,
        level: c.level,
        heldOn: dayStr(c.heldOn)!,
        result: c.result,
        daysAway: daysBetween(today, dayStr(c.heldOn)!),
        teams: c._count.entries,
        entries: entries.get(c.id) ?? [],
      })),
      total,
      p,
    );
  }

  /** Entries of these competitions whose projects the user may see. */
  private async visibleEntries(user: AuthUser, competitionIds: string[]) {
    const out = new Map<string, { projectId: string; code: string; title: string; result: string | null; studentId: string; studentName: string }[]>();
    if (!competitionIds.length) return out;
    const scope = await this.lab.studentScope(user);
    const rows = await this.prisma.innovationCompetitionEntry.findMany({
      where: { competitionId: { in: competitionIds }, project: this.lab.projectWhere(user, scope) },
      include: { project: { select: { id: true, code: true, title: true, studentId: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const students = await this.lab.students(rows.map((r) => r.project.studentId));
    for (const r of rows) {
      const list = out.get(r.competitionId) ?? [];
      list.push({
        projectId: r.project.id,
        code: r.project.code,
        title: r.project.title,
        result: r.result,
        studentId: r.project.studentId,
        studentName: students.get(r.project.studentId)?.fullName ?? 'Unknown student',
      });
      out.set(r.competitionId, list);
    }
    return out;
  }

  @Post('competitions')
  @RequirePermissions('innovation.manage')
  async create(@Body() dto: CompetitionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const c = await this.prisma.innovationCompetition.create({
      data: { name: dto.name.trim(), level: dto.level, heldOn: asDate(dto.heldOn), result: dto.result?.trim() || null, createdById: user.id },
    });
    await this.audit.record({
      user, action: 'create', module: 'innovation', entityType: 'innovation_competition', entityId: c.id,
      description: `Registered for ${c.name} (${c.level}, ${dto.heldOn})`, req,
    });
    return ok({ id: c.id }, 'Competition registered');
  }

  @Put('competitions/:id')
  @RequirePermissions('innovation.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CompetitionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const c = await this.prisma.innovationCompetition.findUnique({ where: { id } });
    if (!c) throw notFound('Competition');
    const updated = await this.prisma.innovationCompetition.update({
      where: { id },
      data: { name: dto.name.trim(), level: dto.level, heldOn: asDate(dto.heldOn), result: dto.result?.trim() || null },
    });
    await this.audit.record({
      user, action: 'update', module: 'innovation', entityType: 'innovation_competition', entityId: id,
      description: `Updated competition ${updated.name}${(updated.result ?? null) !== (c.result ?? null) ? ` — result: ${updated.result ?? 'cleared'}` : ''}`, req,
    });
    return ok({ id }, 'Competition updated');
  }

  @Post('competitions/:id/entries')
  @RequirePermissions('innovation.manage')
  async addEntry(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EntryDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const c = await this.prisma.innovationCompetition.findUnique({ where: { id } });
    if (!c) throw notFound('Competition');
    const project = await this.lab.assertProject(user, dto.projectId).catch((e) => {
      if (e instanceof Error && /not found/i.test(e.message)) throw fieldError('projectId', 'Choose a project');
      throw e;
    });
    if (project.stage < 3) throw fieldError('projectId', 'Only projects at Project stage or beyond can be entered');
    if (project.status !== 'Active') throw badRequest(`${project.code} is already complete`);
    const existing = await this.prisma.innovationCompetitionEntry.findUnique({ where: { competitionId_projectId: { competitionId: id, projectId: project.id } } });
    if (existing) throw conflict(`${project.code} is already entered in ${c.name}`);
    await this.prisma.$transaction(async (tx) => {
      await tx.innovationCompetitionEntry.create({ data: { competitionId: id, projectId: project.id, enteredById: user.id, result: null } });
      await tx.innovationProject.update({ where: { id: project.id }, data: { stage: Math.max(project.stage, COMPETITION_STAGE) } });
    });
    await this.audit.record({
      user, action: 'create', module: 'innovation', entityType: 'innovation_competition', entityId: id, campusId: project.campusId,
      description: `Entered ${project.code} in ${c.name}${project.stage < COMPETITION_STAGE ? ` (moved from ${STAGES[project.stage]} to ${STAGES[COMPETITION_STAGE]})` : ''}`, req,
    });
    await this.lab.notifyStudent(project.studentId, {
      topic: 'innovation', module: 'innovation', category: 'Information', icon: 'award', title: `${project.code} entered in ${c.name}`,
      body: `${project.title} — ${c.level} level, ${dayStr(c.heldOn)}.`,
    });
    return ok({ competitionId: id, projectId: project.id }, 'Project entered');
  }

  @Patch('competitions/:id/entries/:projectId')
  @RequirePermissions('innovation.manage')
  async setResult(
    @Param('id', ParseUUIDPipe) id: string, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: EntryResultDto,
    @CurrentUser() user: AuthUser, @Req() req: Request,
  ) {
    const entry = await this.prisma.innovationCompetitionEntry.findUnique({ where: { competitionId_projectId: { competitionId: id, projectId } }, include: { competition: true } });
    if (!entry) throw notFound('Entry');
    const project = await this.lab.assertProject(user, projectId);
    const result = dto.result.trim();
    if (!result) throw fieldError('result', 'Enter the result');
    if (result === entry.result) return ok({ result }, 'Result saved');
    await this.prisma.innovationCompetitionEntry.update({ where: { competitionId_projectId: { competitionId: id, projectId } }, data: { result } });
    await this.lab.touch(projectId);
    await this.audit.record({
      user, action: 'update', module: 'innovation', entityType: 'innovation_competition', entityId: id, campusId: project.campusId,
      description: `Result for ${project.code} at ${entry.competition.name}: ${result}`, req,
    });
    if (PLACED_RE.test(result)) {
      await this.lab.notifyStudent(project.studentId, {
        topic: 'innovation', module: 'innovation', category: 'Completed', icon: 'award', title: `${entry.competition.name}: ${result}`,
        body: `${project.code} ${project.title}`, deliver: true,
      });
    }
    return ok({ result }, 'Result saved');
  }

  @Delete('competitions/:id/entries/:projectId')
  @RequirePermissions('innovation.manage')
  async removeEntry(@Param('id', ParseUUIDPipe) id: string, @Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const entry = await this.prisma.innovationCompetitionEntry.findUnique({ where: { competitionId_projectId: { competitionId: id, projectId } }, include: { competition: true } });
    if (!entry) throw notFound('Entry');
    const project = await this.lab.assertProject(user, projectId);
    await this.prisma.innovationCompetitionEntry.delete({ where: { competitionId_projectId: { competitionId: id, projectId } } });
    await this.lab.touch(projectId);
    await this.audit.record({
      user, action: 'delete', module: 'innovation', entityType: 'innovation_competition', entityId: id, campusId: project.campusId,
      description: `Withdrew ${project.code} from ${entry.competition.name}`, req,
    });
    return ok(null, 'Entry withdrawn');
  }
}
