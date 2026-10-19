import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { ListQuery } from '../../common/paging';
import { AssessmentsService } from './assessments.service';

class AssessmentQuery extends ListQuery {
  @IsOptional() @IsIn(['Scheduled', 'In Progress', 'Moderation', 'Completed']) status?: string;
  @IsOptional() @IsString() subjectId?: string;
}

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class CreateAssessmentDto {
  @IsString() @MinLength(3, { message: 'Enter a name (at least 3 characters)' }) @MaxLength(160) name: string;
  @IsUUID('all', { message: 'Choose a subject' }) subjectId: string;
  @IsUUID('all', { message: 'Choose a grade' }) classId: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID('all', { message: 'Choose a section' }) sectionId?: string | null;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Choose a date' }) heldOn: string;
  @Type(() => Number) @IsNumber({}, { message: 'Enter a number between 1 and 1000' }) @Min(1, { message: 'Enter a number between 1 and 1000' }) @Max(1000, { message: 'Enter a number between 1 and 1000' }) maxMarks: number;
  @IsOptional() @IsIn(['test', 'exam', 'unit_test', 'quiz', 'mock', 'project'], { message: 'Choose an assessment type' }) assessmentType?: string;
}

class MarkDto {
  @IsUUID('all', { message: 'Unknown student' }) studentId: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({}, { message: 'Enter a number' }) marks: number | null;
  @IsBoolean() isAbsent: boolean;
}

class SaveMarksDto {
  @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => MarkDto) marks: MarkDto[];
  @IsIn(['save', 'moderation', 'complete'], { message: 'Unknown action' }) action: 'save' | 'moderation' | 'complete';
}

@Controller('academics/assessments')
export class AssessmentsController {
  constructor(private readonly assessments: AssessmentsService) {}

  @Get('summary')
  @RequirePermissions('academics.read', 'assessments.manage')
  summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    return this.assessments.summary(user, q.campusId);
  }

  @Get()
  @RequirePermissions('academics.read', 'assessments.manage')
  async list(@Query() q: AssessmentQuery, @CurrentUser() user: AuthUser) {
    const r = await this.assessments.list(user, q);
    return paged(r.rows, r.total, r.p);
  }

  @Post()
  @RequirePermissions('assessments.manage')
  async create(@Body() dto: CreateAssessmentDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const a = await this.assessments.create(user, dto, req);
    return ok({ id: a.id, code: a.code }, `Assessment ${a.code} created`);
  }

  @Get(':id')
  @RequirePermissions('academics.read', 'assessments.manage')
  detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.assessments.detail(user, id);
  }

  @Put(':id/marks')
  @RequirePermissions('assessments.manage')
  async marks(@Param('id') id: string, @Body() dto: SaveMarksDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.assessments.saveMarks(
      user,
      id,
      dto.marks.map((m) => ({ studentId: m.studentId, marks: m.marks ?? null, isAbsent: !!m.isAbsent })),
      dto.action,
      req,
    );
    return ok({ status: r.status, entered: r.entered, of: r.of }, r.message);
  }
}
