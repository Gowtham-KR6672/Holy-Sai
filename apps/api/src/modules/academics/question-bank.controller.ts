import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Prisma, QuestionBankItem } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { conflict, fieldError, forbidden, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AcademicsAccess } from './academics.access';

const TYPES = ['short', 'mcq', 'long', 'numeric'];
const DIFFICULTIES = ['Foundation', 'Core', 'Higher'];
const STATUSES = ['Draft', 'Approved', 'Retired'];

class TopicQuery {
  @IsOptional() @IsString() subjectId?: string;
  @IsOptional() @IsString() q?: string;
}

class QuestionQuery extends ListQuery {
  @IsOptional() @IsString() subjectId?: string;
  @IsOptional() @IsString() topic?: string;
  @IsOptional() @IsIn(DIFFICULTIES) difficulty?: string;
  @IsOptional() @IsIn(STATUSES) status?: string;
}

class QuestionUpdateDto {
  @IsOptional() @IsString() @MinLength(2, { message: 'Enter a topic' }) @MaxLength(120) topic?: string;
  @IsOptional() @IsString() @MinLength(1, { message: 'Enter a stage' }) @MaxLength(40) stageLabel?: string;
  @IsOptional() @IsString() @MinLength(5, { message: 'Write the question' }) @MaxLength(2000) question?: string;
  @IsOptional() @IsIn(TYPES, { message: 'Choose a question type' }) questionType?: string;
  @IsOptional() @IsIn(DIFFICULTIES, { message: 'Choose a difficulty' }) difficulty?: string;
  @IsOptional() @Type(() => Number) @IsInt({ message: '1–100' }) @Min(1, { message: '1–100' }) @Max(100, { message: '1–100' }) marks?: number;
  @IsOptional() @IsIn(STATUSES, { message: 'Choose a status' }) status?: string;
}

class QuestionCreateDto {
  @IsUUID('all', { message: 'Choose a subject' }) subjectId: string;
  @IsString() @MinLength(2, { message: 'Enter a topic' }) @MaxLength(120) topic: string;
  @IsString() @MinLength(1, { message: 'Enter a stage' }) @MaxLength(40) stageLabel: string;
  @IsString() @MinLength(5, { message: 'Write the question' }) @MaxLength(2000) question: string;
  @IsOptional() @IsIn(TYPES, { message: 'Choose a question type' }) questionType?: string;
  @IsOptional() @IsIn(DIFFICULTIES, { message: 'Choose a difficulty' }) difficulty?: string;
  @IsOptional() @Type(() => Number) @IsInt({ message: '1–100' }) @Min(1, { message: '1–100' }) @Max(100, { message: '1–100' }) marks?: number;
  @IsOptional() @IsIn(STATUSES, { message: 'Choose a status' }) status?: string;
}

@Controller('academics/question-bank')
export class QuestionBankController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademicsAccess,
    private readonly audit: AuditService,
  ) {}

  /** Questions grouped by subject, topic and stage. */
  @Get('topics')
  @RequirePermissions('academics.read')
  async topics(@Query() q: TopicQuery) {
    const items = await this.prisma.questionBankItem.findMany({
      where: { ...(q.subjectId ? { subjectId: q.subjectId } : {}) },
      select: { subjectId: true, topic: true, stageLabel: true, status: true, timesUsed: true, difficulty: true },
    });
    const subjects = await this.access.subjectNames(items.map((i) => i.subjectId));
    const groups = new Map<string, { topic: string; subjectId: string; subject: string; stage: string; items: number; used: number; drafts: number; diffs: Set<string> }>();
    for (const i of items) {
      const k = `${i.subjectId}|${i.topic.toLowerCase()}|${i.stageLabel.toLowerCase()}`;
      const g = groups.get(k) ?? { topic: i.topic, subjectId: i.subjectId, subject: subjects.get(i.subjectId) ?? '', stage: i.stageLabel, items: 0, used: 0, drafts: 0, diffs: new Set<string>() };
      if (i.status !== 'Retired') {
        g.items++;
        g.diffs.add(i.difficulty);
      }
      if (i.status === 'Draft') g.drafts++;
      g.used += i.timesUsed;
      groups.set(k, g);
    }
    const term = q.q?.trim().toLowerCase();
    return [...groups.values()]
      .filter((g) => !term || g.topic.toLowerCase().includes(term) || g.subject.toLowerCase().includes(term) || g.stage.toLowerCase().includes(term))
      .map(({ diffs, ...g }) => ({ ...g, difficulty: diffs.size === 1 ? [...diffs][0] : 'Mixed' }))
      .sort((a, b) => a.subject.localeCompare(b.subject) || a.stage.localeCompare(b.stage, undefined, { numeric: true }) || a.topic.localeCompare(b.topic));
  }

  @Get()
  @RequirePermissions('academics.read')
  async list(@Query() q: QuestionQuery) {
    const p = pageOf(q, 10);
    const where: Prisma.QuestionBankItemWhereInput = {
      ...(q.subjectId ? { subjectId: q.subjectId } : {}),
      ...(q.topic ? { topic: { equals: q.topic, mode: 'insensitive' } } : {}),
      ...(q.difficulty ? { difficulty: q.difficulty } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { question: like(q.q) } : {}),
    };
    const dir = q.dir ?? 'asc';
    const orderBy: Prisma.QuestionBankItemOrderByWithRelationInput[] =
      q.sort === 'difficulty' ? [{ difficulty: dir }] : q.sort === 'used' ? [{ timesUsed: dir }] : q.sort === 'status' ? [{ status: dir }] : [{ question: dir }];
    const [rows, total] = await Promise.all([
      this.prisma.questionBankItem.findMany({ where, orderBy, skip: p.skip, take: p.take }),
      this.prisma.questionBankItem.count({ where }),
    ]);
    const subjects = await this.access.subjectNames(rows.map((r) => r.subjectId));
    return paged(rows.map((r) => this.row(r, subjects)), total, p);
  }

  @Post()
  @RequirePermissions('academics.manage')
  async create(@Body() dto: QuestionCreateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const subject = await this.prisma.subject.findUnique({ where: { id: dto.subjectId } });
    if (!subject) throw fieldError('subjectId', 'Choose a subject');
    if (dto.status === 'Retired') throw fieldError('status', 'A new question cannot be retired');
    const item = await this.prisma.questionBankItem.create({
      data: {
        subjectId: dto.subjectId,
        topic: dto.topic.trim(),
        stageLabel: dto.stageLabel.trim(),
        question: dto.question.trim(),
        questionType: dto.questionType ?? 'short',
        difficulty: dto.difficulty ?? 'Core',
        marks: dto.marks ?? 1,
        status: dto.status ?? 'Draft',
        createdById: user.id,
        createdByName: user.fullName,
      },
    });
    await this.audit.record({ user, action: 'create', module: 'academics', entityType: 'question', entityId: item.id, description: `Added a ${subject.name} question to "${item.topic}" (${item.status})`, req });
    return ok(this.row(item, new Map([[subject.id, subject.name]])), 'Question added');
  }

  @Put(':id')
  @RequirePermissions('academics.manage')
  async update(@Param('id') id: string, @Body() dto: QuestionUpdateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const item = await this.editable(id, user);
    const data: Prisma.QuestionBankItemUpdateInput = {};
    if (dto.topic !== undefined) data.topic = dto.topic.trim();
    if (dto.stageLabel !== undefined) data.stageLabel = dto.stageLabel.trim();
    if (dto.question !== undefined) data.question = dto.question.trim();
    if (dto.questionType !== undefined) data.questionType = dto.questionType;
    if (dto.difficulty !== undefined) data.difficulty = dto.difficulty;
    if (dto.marks !== undefined) data.marks = dto.marks;
    if (dto.status !== undefined) data.status = dto.status;
    const updated = await this.prisma.questionBankItem.update({ where: { id }, data });
    const retired = dto.status === 'Retired' && item.status !== 'Retired';
    await this.audit.record({
      user, action: 'update', module: 'academics', entityType: 'question', entityId: id, req,
      description: retired ? `Retired a question from "${item.topic}"` : `Updated a question in "${updated.topic}"${dto.status && dto.status !== item.status ? ` (${item.status} → ${dto.status})` : ''}`,
    });
    const subjects = await this.access.subjectNames([updated.subjectId]);
    return ok(this.row(updated, subjects), retired ? 'Question retired' : 'Question updated');
  }

  @Delete(':id')
  @RequirePermissions('academics.manage')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const item = await this.editable(id, user);
    if (item.timesUsed > 0) throw conflict('This question has been used in assessments. Retire it instead.');
    await this.prisma.questionBankItem.delete({ where: { id } });
    await this.audit.record({ user, action: 'delete', module: 'academics', entityType: 'question', entityId: id, description: `Deleted an unused question from "${item.topic}"`, req });
    return ok(null, 'Question deleted');
  }

  /** Academic office edits any question; teachers edit their own. */
  private async editable(id: string, user: AuthUser): Promise<QuestionBankItem> {
    const item = await this.prisma.questionBankItem.findUnique({ where: { id } });
    if (!item) throw notFound('Question');
    if (!user.permissions.has('students.read') && item.createdById !== user.id) throw forbidden('You can change only the questions you added');
    return item;
  }

  private row(r: QuestionBankItem, subjects: Map<string, string>) {
    return {
      id: r.id,
      subjectId: r.subjectId,
      subject: subjects.get(r.subjectId) ?? '',
      topic: r.topic,
      stageLabel: r.stageLabel,
      question: r.question,
      questionType: r.questionType,
      difficulty: r.difficulty,
      marks: r.marks,
      timesUsed: r.timesUsed,
      status: r.status,
      createdById: r.createdById,
      createdBy: r.createdByName,
    };
  }
}
