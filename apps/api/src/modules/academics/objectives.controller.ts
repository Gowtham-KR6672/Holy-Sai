import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import type { CurriculumObjective, Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, conflict, fieldError, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { AcademicsAccess } from './academics.access';
import { CurriculumService } from './curriculum.service';

const CODE = /^[A-Za-z0-9.\-]{2,20}$/;

class ObjectiveQuery extends ListQuery {
  @IsOptional() @IsString() subjectId?: string;
  @IsOptional() @IsString() stage?: string;
}

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class ObjectiveUpdateDto {
  @IsString() @MinLength(3, { message: 'Describe the objective' }) @MaxLength(300) description: string;
  @IsString() @MinLength(1, { message: 'Enter the stage (e.g. Primary 5)' }) @MaxLength(40) stageLabel: string;
  @Type(() => Number) @IsInt({ message: '0–100' }) @Min(0, { message: '0–100' }) @Max(100, { message: '0–100' }) coveragePct: number;
  @Type(() => Number) @IsInt({ message: '0–100' }) @Min(0, { message: '0–100' }) @Max(100, { message: '0–100' }) masteryPct: number;
}

class ObjectiveCreateDto {
  @Matches(CODE, { message: 'Use 2–20 letters, numbers, dots or dashes (e.g. 5Nf.09)' }) code: string;
  @IsUUID('all', { message: 'Choose a subject' }) subjectId: string;
  @IsString() @MinLength(3, { message: 'Describe the objective' }) @MaxLength(300) description: string;
  @IsString() @MinLength(1, { message: 'Enter the stage (e.g. Primary 5)' }) @MaxLength(40) stageLabel: string;
  @Type(() => Number) @IsInt({ message: '0–100' }) @Min(0, { message: '0–100' }) @Max(100, { message: '0–100' }) coveragePct: number;
  @Type(() => Number) @IsInt({ message: '0–100' }) @Min(0, { message: '0–100' }) @Max(100, { message: '0–100' }) masteryPct: number;
}

class ImportDto {
  @IsArray() @ArrayMinSize(1, { message: 'Paste at least one objective' }) @ArrayMaxSize(200, { message: 'Import at most 200 objectives at a time' })
  @ValidateNested({ each: true }) @Type(() => ObjectiveCreateDto)
  rows: ObjectiveCreateDto[];
}

@Controller('academics')
export class ObjectivesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly access: AcademicsAccess,
    private readonly curriculum: CurriculumService,
    private readonly audit: AuditService,
  ) {}

  /** Stages, coverage by subject and the term trend. */
  @Get('curriculum')
  @RequirePermissions('academics.read')
  async overview(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.access.restricted(user) ? user.campusId ?? undefined : this.scope.campus(user, q.campusId);
    const [stages, classes, objectives, snapshots, subjects] = await Promise.all([
      this.curriculum.stages(),
      this.prisma.schoolClass.findMany({ where: campusId ? { campusId } : {}, include: { sections: { select: { id: true } } } }),
      this.prisma.curriculumObjective.findMany({ select: { subjectId: true, stageLabel: true, coveragePct: true, masteryPct: true } }),
      this.prisma.curriculumSnapshot.findMany({ orderBy: { termStart: 'asc' } }),
      this.prisma.subject.findMany({ select: { id: true, name: true } }),
    ]);
    const sectionIds = classes.flatMap((c) => c.sections.map((s) => s.id));
    const [students, entries] = await Promise.all([
      this.prisma.student.groupBy({ by: ['sectionId'], where: { status: 'active', sectionId: { in: sectionIds } }, _count: { _all: true } }),
      this.prisma.timetableEntry.findMany({ where: { sectionId: { in: sectionIds }, subjectId: { not: null } }, select: { sectionId: true, subjectId: true }, distinct: ['sectionId', 'subjectId'] }),
    ]);
    const studentsBySection = new Map(students.map((s) => [s.sectionId, s._count._all]));
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

    const stageRows = stages.map((st) => {
      const mine = classes.filter((c) => this.curriculum.stageForClass(stages, c)?.id === st.id);
      const secIds = new Set(mine.flatMap((c) => c.sections.map((s) => s.id)));
      const objs = objectives.filter((o) => this.curriculum.stageForLabel(stages, o.stageLabel)?.id === st.id);
      const subjectIds = new Set([...entries.filter((e) => secIds.has(e.sectionId)).map((e) => e.subjectId!), ...objs.map((o) => o.subjectId)]);
      return {
        id: st.id,
        stage: st.name,
        grades: st.gradeFrom === st.gradeTo ? `Grade ${st.gradeFrom}` : `Grades ${st.gradeFrom}–${st.gradeTo}`,
        students: [...secIds].reduce((n, id) => n + (studentsBySection.get(id) ?? 0), 0),
        subjects: subjectIds.size,
        classes: secIds.size,
        coverage: avg(objs.map((o) => o.coveragePct)),
      };
    });

    const names = new Map(subjects.map((s) => [s.id, s.name]));
    const bySubject = new Map<string, { cov: number[]; mas: number[] }>();
    for (const o of objectives) {
      const g = bySubject.get(o.subjectId) ?? { cov: [], mas: [] };
      g.cov.push(o.coveragePct);
      g.mas.push(o.masteryPct);
      bySubject.set(o.subjectId, g);
    }
    const coverageBySubject = [...bySubject]
      .map(([id, g]) => ({ subject: names.get(id) ?? 'Subject', coverage: avg(g.cov), mastery: avg(g.mas), objectives: g.cov.length }))
      .sort((a, b) => a.subject.localeCompare(b.subject));
    return {
      stages: stageRows,
      coverageBySubject,
      trend: {
        labels: snapshots.map((s) => s.termLabel),
        coverage: snapshots.map((s) => Math.round(s.coverage)),
        mastery: snapshots.map((s) => Math.round(s.mastery)),
      },
      totals: objectives.length
        ? { coverage: avg(objectives.map((o) => o.coveragePct)), mastery: avg(objectives.map((o) => o.masteryPct)), objectives: objectives.length }
        : null,
    };
  }

  @Get('objectives/stages')
  @RequirePermissions('academics.read')
  async stageLabels() {
    const rows = await this.prisma.curriculumObjective.findMany({ select: { stageLabel: true }, distinct: ['stageLabel'] });
    return rows.map((r) => r.stageLabel).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  @Get('objectives')
  @RequirePermissions('academics.read')
  async list(@Query() q: ObjectiveQuery) {
    const p = pageOf(q);
    const where: Prisma.CurriculumObjectiveWhereInput = {
      ...(q.subjectId ? { subjectId: q.subjectId } : {}),
      ...(q.stage ? { stageLabel: q.stage } : {}),
      ...(q.q ? { OR: [{ code: like(q.q) }, { description: like(q.q) }, { stageLabel: like(q.q) }] } : {}),
    };
    const dir = q.dir ?? 'asc';
    const sort = q.sort ?? 'code';
    let rows: CurriculumObjective[];
    const total = await this.prisma.curriculumObjective.count({ where });
    const subjects = await this.prisma.subject.findMany({ select: { id: true, name: true } });
    const names = new Map(subjects.map((s) => [s.id, s.name]));
    if (sort === 'subject') {
      const all = await this.prisma.curriculumObjective.findMany({ where });
      all.sort((a, b) => ((names.get(a.subjectId) ?? '').localeCompare(names.get(b.subjectId) ?? '') || a.code.localeCompare(b.code)) * (dir === 'desc' ? -1 : 1));
      rows = all.slice(p.skip, p.skip + p.take);
    } else {
      const field = ({ text: 'description', stage: 'stageLabel', coverage: 'coveragePct', mastery: 'masteryPct' } as Record<string, string>)[sort] ?? 'code';
      rows = await this.prisma.curriculumObjective.findMany({
        where,
        orderBy: [{ [field]: dir } as Prisma.CurriculumObjectiveOrderByWithRelationInput, { code: 'asc' }],
        skip: p.skip,
        take: p.take,
      });
    }
    const plans = rows.length
      ? await this.prisma.lessonPlan.groupBy({ by: ['objectiveId'], where: { objectiveId: { in: rows.map((r) => r.id) } }, _count: { _all: true } })
      : [];
    return paged(rows.map((r) => this.row(r, names, plans.find((x) => x.objectiveId === r.id)?._count._all ?? 0)), total, p);
  }

  @Post('objectives')
  @RequirePermissions('academics.manage')
  async create(@Body() dto: ObjectiveCreateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (dto.masteryPct > dto.coveragePct) throw fieldError('masteryPct', 'Mastery cannot exceed coverage');
    const subject = await this.prisma.subject.findUnique({ where: { id: dto.subjectId } });
    if (!subject) throw fieldError('subjectId', 'Choose a subject');
    const code = dto.code.trim();
    if (await this.prisma.curriculumObjective.findFirst({ where: { code: { equals: code, mode: 'insensitive' } } })) throw fieldError('code', 'This objective code already exists');
    const o = await this.prisma.curriculumObjective.create({
      data: { code, description: dto.description.trim(), subjectId: subject.id, stageLabel: dto.stageLabel.trim(), coveragePct: dto.coveragePct, masteryPct: dto.masteryPct, createdById: user.id },
    });
    await this.curriculum.snapshot();
    await this.audit.record({ user, action: 'create', module: 'academics', entityType: 'objective', entityId: o.id, description: `Mapped ${subject.name} objective ${o.code} (${o.stageLabel})`, req });
    return ok(this.row(o, new Map([[subject.id, subject.name]]), 0), 'Objective added');
  }

  @Put('objectives/:id')
  @RequirePermissions('academics.manage')
  async update(@Param('id') id: string, @Body() dto: ObjectiveUpdateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const o = await this.prisma.curriculumObjective.findUnique({ where: { id } });
    if (!o) throw notFound('Objective');
    if (dto.masteryPct > dto.coveragePct) throw fieldError('masteryPct', 'Mastery cannot exceed coverage');
    const updated = await this.prisma.curriculumObjective.update({
      where: { id },
      data: { description: dto.description.trim(), stageLabel: dto.stageLabel.trim(), coveragePct: dto.coveragePct, masteryPct: dto.masteryPct },
    });
    await this.curriculum.snapshot();
    await this.audit.record({
      user, action: 'update', module: 'academics', entityType: 'objective', entityId: id, req,
      description: `Updated objective ${o.code}: coverage ${o.coveragePct}% → ${dto.coveragePct}%, mastery ${o.masteryPct}% → ${dto.masteryPct}%`,
    });
    const names = await this.access.subjectNames([o.subjectId]);
    const plans = await this.prisma.lessonPlan.count({ where: { objectiveId: id } });
    return ok(this.row(updated, names, plans), 'Objective updated');
  }

  /** All-or-nothing import of pasted objectives. */
  @Post('objectives/import')
  @RequirePermissions('academics.manage')
  async import(@Body() dto: ImportDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const subjectIds = new Set((await this.prisma.subject.findMany({ select: { id: true } })).map((s) => s.id));
    const codes = new Set<string>();
    dto.rows.forEach((r, i) => {
      const code = r.code.trim().toLowerCase();
      if (!subjectIds.has(r.subjectId)) throw badRequest(`Line ${i + 1}: unknown subject`);
      if (r.masteryPct > r.coveragePct) throw badRequest(`Line ${i + 1}: mastery cannot exceed coverage`);
      if (codes.has(code)) throw conflict(`Objective ${r.code} appears twice — nothing was imported`);
      codes.add(code);
    });
    const existing = await this.prisma.curriculumObjective.findMany({ where: { OR: dto.rows.map((r) => ({ code: { equals: r.code.trim(), mode: 'insensitive' as const } })) }, select: { code: true } });
    if (existing.length) throw conflict(`${existing.map((e) => e.code).slice(0, 5).join(', ')} already exist${existing.length === 1 ? 's' : ''} — nothing was imported`);
    await this.prisma.$transaction(async (tx) => {
      await tx.curriculumObjective.createMany({
        data: dto.rows.map((r) => ({
          code: r.code.trim(), description: r.description.trim(), subjectId: r.subjectId, stageLabel: r.stageLabel.trim(),
          coveragePct: r.coveragePct, masteryPct: r.masteryPct, createdById: user.id,
        })),
      });
    });
    await this.curriculum.snapshot();
    await this.audit.record({ user, action: 'create', module: 'academics', entityType: 'objective', description: `Imported ${dto.rows.length} curriculum objectives`, metadata: { codes: dto.rows.map((r) => r.code) }, req });
    return ok({ imported: dto.rows.length }, `${dto.rows.length} objectives imported`);
  }

  private row(r: CurriculumObjective, names: Map<string, string>, lessonPlans: number) {
    return {
      id: r.id,
      code: r.code,
      text: r.description,
      subjectId: r.subjectId,
      subject: names.get(r.subjectId) ?? '',
      stage: r.stageLabel,
      coverage: r.coveragePct,
      mastery: r.masteryPct,
      lessonPlans,
    };
  }
}
