import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { INCIDENT_ENTITY, IncidentsService, SEVERITY_ORDER, STATUS_ORDER } from './incidents.service';
import { INCIDENT_STATUSES, INCIDENT_TYPES, SafetyContext, SENSITIVE, SEVERITIES, sortRows } from './safety.util';

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class IncidentQuery extends ListQuery {
  @IsOptional() @IsIn(INCIDENT_TYPES) type?: string;
  @IsOptional() @IsIn(INCIDENT_STATUSES) status?: string;
  @IsOptional() @IsIn(SEVERITIES) severity?: string;
  @IsOptional() @IsUUID() studentId?: string;
}

class CreateIncidentDto {
  @IsIn(INCIDENT_TYPES, { message: 'Choose the incident type' }) incidentType: string;
  @IsString() @MinLength(5, { message: 'Describe the incident in at least 5 characters' }) @MaxLength(200) summary: string;
  @IsOptional() @IsString() @MaxLength(4000) details?: string;
  @IsIn(SEVERITIES, { message: 'Choose the severity' }) severity: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Choose the date' }) occurredOn: string;
  @IsOptional() @IsBoolean() isConfidential?: boolean;
  @IsOptional() @IsUUID() studentId?: string;
  @IsOptional() @IsUUID() ownerId?: string;
  @IsOptional() @IsUUID() campusId?: string;
}

class UpdateIncidentDto {
  @IsOptional() @IsIn(INCIDENT_STATUSES) status?: string;
  @IsOptional() @IsIn(SEVERITIES) severity?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() ownerId?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(20000) details?: string | null;
}

@Controller('incidents')
export class IncidentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: SafetyContext,
    private readonly incidents: IncidentsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('safety.read', 'safety.manage')
  async list(@Query() q: IncidentQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campus = this.ctx.campus(user, q.campusId);
    const term = q.q?.trim();
    const where: Prisma.SafetyIncidentWhereInput = {
      ...(campus ? { campusId: campus } : {}),
      ...(user.permissions.has(SENSITIVE) ? {} : { isConfidential: false }),
      ...(q.type ? { incidentType: q.type } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.severity ? { severity: q.severity } : {}),
      ...(q.studentId ? { studentId: q.studentId } : {}),
      ...(term ? { OR: [{ code: { contains: term, mode: 'insensitive' } }, { summary: { contains: term, mode: 'insensitive' } }] } : {}),
    };
    const list = await this.prisma.safetyIncident.findMany({ where, orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }], take: 10_000 });
    const rows = await this.incidents.rows(list);
    const sorted = sortRows(rows, q.sort, q.dir, {
      code: (r) => r.code,
      date: (r) => `${r.occurredOn}|${r.createdAt}`,
      type: (r) => r.incidentType,
      severity: (r) => SEVERITY_ORDER[r.severity] ?? 9,
      status: (r) => STATUS_ORDER[r.status] ?? 9,
      owner: (r) => r.ownerName,
    }, 'date', 'desc');
    return paged(sorted.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  @Get('summary')
  @RequirePermissions('safety.read', 'safety.manage')
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const clock = await this.ctx.clock();
    const year = await this.ctx.academicYear(clock);
    const campus = this.ctx.campus(user, q.campusId);
    const base: Prisma.SafetyIncidentWhereInput = campus ? { campusId: campus } : {};
    const concerns: Prisma.SafetyIncidentWhereInput = { ...base, incidentType: 'Safeguarding' };
    const since30 = new Date(Date.now() - 30 * 24 * 3600_000);

    const [openConcerns, underReview, closed, escalated, openAll, confidential, last30Days, byType, compliance] = await Promise.all([
      this.prisma.safetyIncident.count({ where: { ...concerns, status: { not: 'Closed' } } }),
      this.prisma.safetyIncident.count({ where: { ...concerns, status: 'Under Review' } }),
      this.prisma.safetyIncident.findMany({ where: { ...concerns, status: 'Closed', closedAt: { gte: year.start, lt: year.end } }, select: { createdAt: true, closedAt: true } }),
      this.prisma.safetyIncident.count({ where: { ...concerns, status: 'Escalated' } }),
      this.prisma.safetyIncident.count({ where: { ...base, status: { not: 'Closed' } } }),
      this.prisma.safetyIncident.count({ where: { ...base, isConfidential: true, status: { not: 'Closed' } } }),
      this.prisma.safetyIncident.count({ where: { ...base, createdAt: { gte: since30 } } }),
      this.prisma.safetyIncident.groupBy({ by: ['incidentType'], where: { ...base, createdAt: { gte: year.start, lt: year.end } }, _count: { _all: true } }),
      this.incidents.compliance(campus),
    ]);
    const counts = new Map(byType.map((r) => [r.incidentType, r._count._all]));
    return {
      openConcerns,
      underReview,
      closedThisYear: closed.length,
      closedWithin24h: closed.filter((c) => c.closedAt && c.closedAt.getTime() - c.createdAt.getTime() <= 24 * 3600_000).length,
      escalated,
      openAll,
      confidential,
      last30Days,
      byType: INCIDENT_TYPES.map((type) => ({ type, n: counts.get(type) ?? 0 })).sort((a, b) => b.n - a.n),
      compliance,
      canViewConfidential: user.permissions.has(SENSITIVE),
    };
  }

  /** One record. Views of safeguarding and confidential records are written to the audit trail. */
  @Get(':id')
  @RequirePermissions('safety.read', 'safety.manage')
  async one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const incident = await this.incidents.get(user, id);
    if (incident.isConfidential || incident.incidentType === 'Safeguarding') {
      await this.audit.record({
        user, action: 'view', module: 'safety', entityType: INCIDENT_ENTITY, entityId: id, campusId: incident.campusId, sensitive: true, req,
        description: `Viewed ${incident.isConfidential ? 'confidential ' : ''}${incident.incidentType.toLowerCase()} record ${incident.code}`,
      });
    }
    const [row] = await this.incidents.rows([incident]);
    return row;
  }

  @Post()
  @RequirePermissions('safety.manage')
  async create(@Body() dto: CreateIncidentDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const clock = await this.ctx.clock();
    if (dto.occurredOn > clock.today()) throw fieldError('occurredOn', 'Cannot be in the future');
    let campusId: string | undefined;
    if (dto.studentId) {
      const student = await this.ctx.assertStudent(user, dto.studentId);
      campusId = student.campusId;
    }
    if (dto.ownerId) {
      const owner = await this.prisma.employee.findUnique({ where: { id: dto.ownerId }, select: { campusId: true } });
      if (!owner) throw fieldError('ownerId', 'Choose a staff member');
      campusId ??= owner.campusId;
    }
    campusId ??= (await this.ctx.campusFor(user, dto.campusId)) ?? undefined;
    if (!campusId) throw badRequest('Choose a campus in the header before logging an incident');
    // Anyone with safety.manage may raise a confidential concern; only students.sensitive holders can then open it.
    const incident = await this.incidents.create(user, {
      campusId,
      incidentType: dto.incidentType,
      summary: dto.summary.trim(),
      details: dto.details?.trim() || null,
      severity: dto.severity,
      occurredOn: dto.occurredOn,
      isConfidential: !!dto.isConfidential,
      studentId: dto.studentId ?? null,
      ownerId: dto.ownerId,
      source: 'manual',
    }, req);
    const [row] = await this.incidents.rows([incident]);
    const who = dto.incidentType === 'Safeguarding' || dto.severity === 'Critical' ? ' — the Designated Safeguarding Lead has been notified' : '';
    return ok(row, `${incident.code} logged${who}`);
  }

  @Patch(':id')
  @RequirePermissions('safety.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateIncidentDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { incident, message } = await this.incidents.update(user, id, dto, req);
    const [row] = await this.incidents.rows([incident]);
    return ok(row, message);
  }
}
