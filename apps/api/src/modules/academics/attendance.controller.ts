import { Body, Controller, Get, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { badRequest } from '../../common/errors';
import { ATT_STATUSES, AttendanceService, type AttStatus } from './attendance.service';
import { schoolToday } from './academics.util';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class DateQuery {
  @IsOptional() @IsString() campusId?: string;
  @IsOptional() @Matches(DATE, { message: 'Use a date like 2026-10-19' }) date?: string;
}

class RegisterQuery {
  @IsUUID('all', { message: 'Choose a section' }) sectionId: string;
  @IsOptional() @Matches(DATE, { message: 'Use a date like 2026-10-19' }) date?: string;
}

class MarkDto {
  @IsUUID('all', { message: 'Unknown student' }) studentId: string;
  @IsIn(ATT_STATUSES, { message: 'Choose Present, Late, Absent or Leave' }) status: AttStatus;
}

class SaveRegisterDto {
  @IsUUID('all', { message: 'Choose a section' }) sectionId: string;
  @IsOptional() @Matches(DATE, { message: 'Use a date like 2026-10-19' }) date?: string;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => MarkDto) marks: MarkDto[];
}

/** Student attendance: registers per section and day, school-wide figures and analytics. */
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('sections')
  @RequirePermissions('attendance.read', 'attendance.mark')
  sections(@Query() q: DateQuery, @CurrentUser() user: AuthUser) {
    return this.attendance.sections(user, q.campusId, q.date ?? schoolToday());
  }

  @Get('register')
  @RequirePermissions('attendance.read', 'attendance.mark')
  register(@Query() q: RegisterQuery, @CurrentUser() user: AuthUser) {
    return this.attendance.register(user, q.sectionId, q.date);
  }

  @Put('register')
  @RequirePermissions('attendance.mark')
  async save(@Body() dto: SaveRegisterDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (dto.date && dto.date > schoolToday()) throw badRequest('Registers cannot be marked in advance');
    const result = await this.attendance.save(user, dto, req);
    return ok(result, 'Attendance saved');
  }

  @Get('summary')
  @RequirePermissions('attendance.read', 'attendance.mark')
  summary(@Query() q: DateQuery, @CurrentUser() user: AuthUser) {
    return this.attendance.summary(user, q.campusId, q.date);
  }

  @Get('analytics')
  @RequirePermissions('attendance.read')
  analytics(@Query() q: DateQuery, @CurrentUser() user: AuthUser) {
    return this.attendance.analytics(user, q.campusId);
  }
}
