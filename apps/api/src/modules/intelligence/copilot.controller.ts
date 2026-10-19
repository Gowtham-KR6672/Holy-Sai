import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CopilotService, DRAFT_TYPES, type DraftType } from './copilot.service';

class ContextQuery {
  @IsOptional() @IsString() grade?: string;
  @IsOptional() @IsString() subjectId?: string;
  @IsOptional() @IsString() @MaxLength(120) topic?: string;
  @IsOptional() @IsString() sectionId?: string;
}

class DraftsQuery extends ListQuery {
  @IsOptional() @IsIn(['Draft', 'Under Review', 'Approved', 'Rejected']) status?: string;
}

class GenerateDto {
  @IsIn([...DRAFT_TYPES], { message: 'Choose what to draft' }) type: DraftType;
  @Type(() => Number) @IsInt({ message: 'Choose a grade' }) @Min(1) @Max(12) grade: number;
  @IsString({ message: 'Choose a subject' }) subjectId: string;
  @IsString() @MaxLength(80) topic: string;
  @IsOptional() @IsString() sectionId?: string;
  @IsOptional() @IsString() studentId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(15) @Max(120) lessonMinutes?: number;
  @IsOptional() @IsIn(['attendance', 'homework', 'progress', 'general']) messagePurpose?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Choose a valid date' }) plannedFor?: string;
}

class SaveDto {
  @IsObject() output: Record<string, unknown>;
}

class DiscardDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

/** AI Teacher Co-Pilot: drafts are generated, reviewed, edited and approved by a named teacher. */
@Controller('copilot')
@RequirePermissions('ai.use')
export class CopilotController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly copilot: CopilotService,
  ) {}

  @Get('context')
  context(@Query() q: ContextQuery, @CurrentUser() user: AuthUser) {
    return this.copilot.context(user, q);
  }

  @Get('drafts')
  async list(@Query() q: DraftsQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q, 8);
    const where: Prisma.CopilotDraftWhereInput = { AND: [this.copilot.listWhere(user), q.status ? { status: q.status } : {}] };
    const [rows, total] = await Promise.all([
      this.prisma.copilotDraft.findMany({ where, orderBy: { createdAt: q.dir === 'asc' ? 'asc' : 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.copilotDraft.count({ where }),
    ]);
    return paged(rows.map((r) => this.copilot.row(r)), total, p);
  }

  @Post('drafts')
  async create(@Body() dto: GenerateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const d = await this.copilot.generate(user, dto);
    await this.audit.record({
      user, action: 'create', module: 'copilot', entityType: 'copilot_draft', entityId: d.id, campusId: d.campusId, req,
      description: `Generated a ${d.type} draft: ${d.title} (${d.generatorKind === 'model' ? 'language model' : 'templates'})`,
    });
    return ok(this.copilot.view(d), 'Draft generated — review before publishing');
  }

  @Get('drafts/:id')
  async get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.copilot.view(await this.copilot.find(user, id));
  }

  @Put('drafts/:id')
  async save(@Param('id') id: string, @Body() dto: SaveDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const d = await this.copilot.find(user, id);
    this.copilot.assertOpen(d);
    if (JSON.stringify(dto.output).length > 250_000) throw badRequest('The draft is too long to save');
    const prev = d.output as Record<string, unknown>;
    // The generator, sources and warnings stay as generated; everything else is the teacher's edit.
    const output: Record<string, unknown> = { ...prev, ...dto.output, generator: prev.generator, sources: prev.sources, warnings: prev.warnings, edited: { by: user.fullName, at: new Date().toISOString() } };
    if (d.type === 'quiz' && Array.isArray(output.questions)) {
      output.totalMarks = (output.questions as { marks?: unknown }[]).reduce((n, x) => n + (Number(x.marks) || 0), 0);
    }
    const title = typeof output.title === 'string' && output.title.trim() ? output.title.trim().slice(0, 200) : d.title;
    const updated = await this.prisma.copilotDraft.update({ where: { id: d.id }, data: { output: output as Prisma.InputJsonValue, title, status: 'Under Review' } });
    await this.audit.record({ user, action: 'update', module: 'copilot', entityType: 'copilot_draft', entityId: d.id, campusId: d.campusId, req, description: `Edited the draft: ${title}` });
    return ok(this.copilot.view(updated), 'Edits saved — ready for approval');
  }

  @Post('drafts/:id/approve')
  @HttpCode(200)
  async approve(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const d = await this.copilot.find(user, id);
    this.copilot.assertOpen(d);
    const lessonPlanId = d.type === 'lesson' ? await this.copilot.publishLesson(d, user) : null;
    const updated = await this.prisma.copilotDraft.update({
      where: { id: d.id },
      data: { status: 'Approved', approvedAt: new Date(), approvedById: user.id, approvedByName: user.fullName, lessonPlanId },
    });
    await this.audit.record({
      user, action: 'approve', module: 'copilot', entityType: 'copilot_draft', entityId: d.id, campusId: d.campusId, req,
      description: `Approved the AI draft “${d.title}”${lessonPlanId ? ' and published it as an approved lesson plan' : ''}`,
      metadata: { lessonPlanId, generator: (d.output as { generator?: unknown }).generator ?? null } as Prisma.InputJsonValue,
    });
    const msg = d.type === 'lesson'
      ? lessonPlanId ? `Approved — lesson plan created for ${d.classLabel ?? 'the class'}` : 'Approved — no lesson plan was created because the account is not linked to a staff record'
      : 'Approved — ready to use';
    return ok(this.copilot.view(updated), msg);
  }

  @Post('drafts/:id/discard')
  @HttpCode(200)
  async discard(@Param('id') id: string, @Body() dto: DiscardDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const d = await this.copilot.find(user, id);
    this.copilot.assertOpen(d);
    const output = { ...(d.output as Record<string, unknown>), rejection: { by: user.fullName, at: new Date().toISOString(), reason: dto.reason?.trim() || null } };
    const updated = await this.prisma.copilotDraft.update({ where: { id: d.id }, data: { status: 'Rejected', rejectedAt: new Date(), output: output as Prisma.InputJsonValue } });
    await this.audit.record({ user, action: 'reject', module: 'copilot', entityType: 'copilot_draft', entityId: d.id, campusId: d.campusId, req, description: `Discarded the AI draft “${d.title}”${dto.reason ? `: ${dto.reason}` : ''}` });
    return ok(this.copilot.view(updated), 'Draft discarded');
  }
}
