import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { fieldError, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GroupMetricsService } from './group-metrics.service';
import { uuidOr404 } from './insights.util';
import { TransfersService } from './transfers.service';

class CampusEditDto {
  @IsString() @MinLength(2, { message: 'Enter the campus name' }) @MaxLength(120) name: string;
  @IsString() @MinLength(1, { message: 'Enter a short name' }) @MaxLength(40) shortName: string;
  @IsString() @MinLength(2, { message: 'Enter the place' }) @MaxLength(80) place: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(160) curriculum?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @Type(() => Number) @IsInt({ message: 'Enter a year' }) @Min(1900, { message: 'Enter a year from 1900' }) established?: number;
  @IsOptional() @Type(() => Number) @IsInt({ message: 'Enter a whole number of positions' }) @Min(1, { message: 'Enter a whole number of positions' }) @Max(100000)
  staffingTarget?: number;
}

/**
 * Group (multi-campus) views: the campuses with their live figures, the group dashboard and the campus
 * comparison. Campuses are created in School Setup; the details edited here are the same core Campus rows.
 */
@Controller('group')
export class GroupController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: GroupMetricsService,
    private readonly transfers: TransfersService,
    private readonly audit: AuditService,
  ) {}

  @Get('campuses')
  @RequirePermissions('group.read', 'dashboard.group')
  async campuses() {
    return (await this.metrics.all()).campuses;
  }

  @Put('campuses/:id')
  @RequirePermissions('group.manage')
  async updateCampus(@Param('id') id: string, @Body() dto: CampusEditDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    uuidOr404(id, 'Campus');
    const existing = await this.prisma.campus.findUnique({ where: { id } });
    if (!existing) throw notFound('Campus');
    const year = new Date().getFullYear();
    if (dto.established != null && dto.established > year) throw fieldError('established', `Enter a year between 1900 and ${year}`);
    const data = {
      name: dto.name.trim(),
      shortName: dto.shortName.trim(),
      place: dto.place.trim(),
      curriculum: dto.curriculum?.trim() ?? '',
      address: dto.address?.trim() || null,
      ...(dto.established != null ? { establishedYear: dto.established } : {}),
      ...(dto.staffingTarget != null ? { staffingTarget: dto.staffingTarget } : {}),
    };
    const changed = Object.entries(data)
      .filter(([k, v]) => (existing as Record<string, unknown>)[k] !== v)
      .map(([k]) => k);
    await this.prisma.campus.update({ where: { id }, data });
    this.metrics.invalidate();
    await this.audit.record({
      user, action: 'update', module: 'group', entityType: 'campus', entityId: id, campusId: id, req,
      description: `Updated campus ${data.name}${changed.length ? ` (${changed.join(', ')})` : ''}`,
      metadata: Object.fromEntries(changed.map((k) => [k, { from: String((existing as Record<string, unknown>)[k] ?? ''), to: String((data as Record<string, unknown>)[k] ?? '') }])),
    });
    return ok({ id }, 'Campus updated');
  }

  @Get('dashboard')
  @RequirePermissions('dashboard.group')
  async dashboard() {
    const { campuses, rows, raw } = await this.metrics.all();
    const [kpis, transfers] = await Promise.all([this.metrics.kpis(campuses, raw), this.transfers.openForDashboard()]);
    return { kpis, campuses, rows, transfers };
  }

  @Get('comparison')
  @RequirePermissions('group.read', 'dashboard.group')
  async comparison() {
    const { campuses, rows } = await this.metrics.all();
    return { campuses, rows, radar: this.metrics.radar(campuses), generatedAt: new Date().toISOString() };
  }
}
