import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf,
} from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { AuditService } from '../audit/audit.service';
import { WorkforceService } from './workforce.service';
import { CPD_TARGET, MANDATORY_CPD, dateOf, groupBy, keyOrNull, round, sortRows, sumBy, todayKey } from './workforce.util';

const CPD_STATUSES = ['Planned', 'In Progress', 'Completed'];

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class CpdQuery extends ListQuery {
  @IsOptional() @IsIn(['teaching', 'non_teaching']) employeeType?: string;
  @IsOptional() @IsIn(['met', 'near', 'below']) band?: string;
}

class RecordsQuery {
  @IsUUID('all', { message: 'Choose an employee' }) employeeId: string;
}

class CpdDto {
  @IsArray() @ArrayMinSize(1, { message: 'Choose at least one employee' }) @ArrayMaxSize(1000) @IsUUID('all', { each: true }) employeeIds: string[];
  @IsString() @MinLength(3, { message: 'Name the programme' }) @MaxLength(160) programme: string;
  @IsOptional() @IsString() @MaxLength(120) provider?: string | null;
  @Type(() => Number) @IsInt({ message: 'Whole hours, 1–200' }) @Min(1, { message: 'Whole hours, 1–200' }) @Max(200, { message: 'Whole hours, 1–200' }) hours: number;
  @IsIn(CPD_STATUSES) status: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString({}, { message: 'Enter a valid date' }) completedOn?: string | null;
}

class CpdPatchDto {
  @IsOptional() @IsIn(CPD_STATUSES) status?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString({}, { message: 'Enter a valid date' }) completedOn?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) hours?: number;
}

const firstName = (n: string) => n.replace(/^(Dr|Mr|Ms|Mrs)\.?\s+/i, '');

/** Teaching workload against the agreed maximum, and continuing professional development. */
@Controller('workforce')
export class DevelopmentController {
  constructor(
    private readonly wf: WorkforceService,
    private readonly audit: AuditService,
  ) {}

  private get prisma() {
    return this.wf.prisma;
  }

  // ---------------------------------------------------------------------------
  // Workload
  // ---------------------------------------------------------------------------

  @Get('workload')
  @RequirePermissions('hr.read')
  async workload(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.wf.campus(user, q.campusId);
    const teachers = await this.prisma.employee.findMany({ where: this.wf.employeeWhere(campusId, { employeeType: 'teaching' }), orderBy: { fullName: 'asc' } });
    const [load, campuses] = await Promise.all([this.wf.workload(teachers), this.wf.campusNames(teachers.map((t) => t.campusId))]);
    const all = teachers.map((t) => {
      const l = load.get(t.id) ?? { sections: 0, assigned: 0, timetabled: 0, recorded: 0, periods: 0 };
      const max = t.maxPeriodsWeek || 27;
      const band: 'over' | 'near' | 'ok' = l.periods > max ? 'over' : l.periods >= max - 3 ? 'near' : 'ok';
      return {
        id: t.id,
        fullName: t.fullName,
        designation: t.designation,
        department: t.department,
        category: t.category,
        campusName: campuses.get(t.campusId)?.shortName ?? '',
        ...l,
        max,
        band,
      };
    });
    const rows = sortRows(all.filter((r) => r.periods > 0), (r) => r.periods, 'desc');
    const suggestions: { employeeId: string; text: string }[] = [];
    const spare = new Map(all.map((r) => [r.id, r.max - r.periods]));
    for (const r of rows.filter((x) => x.band === 'over')) {
      const excess = r.periods - r.max;
      const colleague = sortRows(
        all.filter((c) => c.id !== r.id && c.department === r.department && (spare.get(c.id) ?? 0) > 3),
        (c) => spare.get(c.id) ?? 0,
        'desc',
      )[0];
      if (colleague) {
        const move = Math.min(excess, (spare.get(colleague.id) ?? 0) - 3);
        spare.set(colleague.id, (spare.get(colleague.id) ?? 0) - move);
        suggestions.push({
          employeeId: r.id,
          text: `${r.fullName} is ${excess} period${excess === 1 ? '' : 's'} above the maximum of ${r.max} — move ${move} period${move === 1 ? '' : 's'} to ${firstName(colleague.fullName)} (${colleague.department}, ${colleague.periods} of ${colleague.max}).`,
        });
      } else {
        suggestions.push({
          employeeId: r.id,
          text: `${r.fullName} is ${excess} period${excess === 1 ? '' : 's'} above the maximum of ${r.max} — no colleague in ${r.department} has spare periods; reduce duties or plan a substitute.`,
        });
      }
    }
    return {
      kpis: {
        teachers: teachers.length,
        average: rows.length ? round(sumBy(rows, (r) => r.periods) / rows.length, 1) : 0,
        over: rows.filter((r) => r.band === 'over').length,
        near: rows.filter((r) => r.band === 'near').length,
      },
      rows,
      suggestions,
    };
  }

  // ---------------------------------------------------------------------------
  // CPD
  // ---------------------------------------------------------------------------

  /** Per-employee CPD position for the year: completed hours, target, mandatory training, planned programmes. */
  private async positions(campusId: string | undefined, extra: { employeeType?: string; q?: string } = {}) {
    const emps = await this.prisma.employee.findMany({
      where: this.wf.employeeWhere(campusId, {
        ...(extra.employeeType ? { employeeType: extra.employeeType } : {}),
        ...(extra.q ? { OR: [{ fullName: like(extra.q) }, { code: like(extra.q) }, { designation: like(extra.q) }] } : {}),
      }),
      orderBy: { fullName: 'asc' },
    });
    const ids = emps.map((e) => e.id);
    const win = await this.wf.yearWindow();
    const records = await this.prisma.workforceCpdRecord.findMany({
      where: {
        employeeId: { in: ids },
        OR: [{ status: { in: ['Planned', 'In Progress'] } }, { status: 'Completed', completedOn: { gte: dateOf(win.from), lte: dateOf(win.to) } }],
      },
    });
    const byEmp = groupBy(records, (r) => r.employeeId);
    return {
      records,
      rows: emps.map((e) => {
        const list = byEmp.get(e.id) ?? [];
        const done = list.filter((r) => r.status === 'Completed');
        const target = this.wf.cpdTarget(e.employeeType);
        return {
          id: e.id,
          code: e.code,
          fullName: e.fullName,
          designation: e.designation,
          department: e.department,
          employeeType: e.employeeType,
          hours: sumBy(done, (r) => r.hours),
          target,
          mandatoryComplete: done.some((r) => r.isMandatory),
          planned: list.filter((r) => r.status !== 'Completed').length,
        };
      }),
    };
  }

  @Get('cpd/summary')
  @RequirePermissions('hr.read')
  async cpdSummary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.wf.campus(user, q.campusId);
    const { rows, records } = await this.positions(campusId);
    const teachers = rows.filter((r) => r.employeeType === 'teaching');
    const mandatoryDone = rows.filter((r) => r.mandatoryComplete).length;
    const open = records.filter((r) => r.status !== 'Completed');
    const upcoming = [...groupBy(open, (r) => `${r.programme}|${r.status}`).entries()]
      .map(([k, list]) => ({ programme: k.split('|')[0], status: k.split('|')[1], staff: new Set(list.map((r) => r.employeeId)).size, hours: list[0].hours }))
      .sort((a, b) => b.staff - a.staff || a.programme.localeCompare(b.programme))
      .slice(0, 8);
    return {
      kpis: {
        hoursLogged: sumBy(rows, (r) => r.hours),
        avgPerTeacher: teachers.length ? round(sumBy(teachers, (r) => r.hours) / teachers.length, 1) : null,
        targetTeaching: CPD_TARGET.teaching,
        targetNonTeaching: CPD_TARGET.non_teaching,
        belowTarget: rows.filter((r) => r.hours < r.target).length,
        mandatoryPct: rows.length ? Math.round((mandatoryDone / rows.length) * 100) : null,
        mandatoryOutstanding: rows.length - mandatoryDone,
      },
      upcoming,
    };
  }

  @Get('cpd')
  @RequirePermissions('hr.read')
  async cpd(@Query() q: CpdQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.wf.campus(user, q.campusId);
    let { rows } = await this.positions(campusId, { employeeType: q.employeeType, q: q.q });
    if (q.band === 'met') rows = rows.filter((r) => r.hours >= r.target);
    else if (q.band === 'near') rows = rows.filter((r) => r.hours < r.target && r.hours >= r.target * 0.6);
    else if (q.band === 'below') rows = rows.filter((r) => r.hours < r.target * 0.6);
    const keys: Record<string, (r: (typeof rows)[number]) => string | number | null> = {
      name: (r) => r.fullName,
      department: (r) => r.department,
      hours: (r) => r.hours,
      progress: (r) => r.hours / r.target,
      mandatory: (r) => (r.mandatoryComplete ? 1 : 0),
      planned: (r) => r.planned,
    };
    rows = sortRows(rows, keys[q.sort ?? ''] ?? keys.name, q.dir ?? 'asc');
    return paged(rows.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  @Get('cpd/records')
  @RequirePermissions('hr.read')
  async records(@Query() q: RecordsQuery, @CurrentUser() user: AuthUser) {
    const e = await this.prisma.employee.findUnique({ where: { id: q.employeeId }, select: { campusId: true } });
    if (!e) throw notFound('Employee');
    const campusId = this.wf.campus(user, null);
    if (campusId && e.campusId !== campusId && !user.permissions.has('dashboard.group')) throw notFound('Employee');
    const rows = await this.prisma.workforceCpdRecord.findMany({
      where: { employeeId: q.employeeId },
      orderBy: [{ completedOn: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
    });
    return rows.map((r) => ({ id: r.id, programme: r.programme, provider: r.provider, hours: r.hours, completedOn: keyOrNull(r.completedOn), status: r.status, isMandatory: r.isMandatory }));
  }

  @Post('cpd')
  @RequirePermissions('hr.manage')
  async create(@Body() dto: CpdDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const completed = dto.status === 'Completed';
    const completedOn = completed ? dto.completedOn?.slice(0, 10) : null;
    if (completed && !completedOn) throw fieldError('completedOn', 'Completion date is required');
    if (completedOn && completedOn > todayKey()) throw fieldError('completedOn', 'Cannot be in the future');
    const ids = [...new Set(dto.employeeIds)];
    const campusId = this.wf.campus(user, null);
    const emps = await this.prisma.employee.findMany({ where: { id: { in: ids }, archivedAt: null, ...(campusId && !user.permissions.has('dashboard.group') ? { campusId } : {}) } });
    if (emps.length !== ids.length) throw fieldError('employeeIds', 'Some chosen employees are not available — refresh and choose again');
    const programme = dto.programme.trim();
    const isMandatory = MANDATORY_CPD.test(programme);
    await this.prisma.workforceCpdRecord.createMany({
      data: emps.map((e) => ({
        employeeId: e.id,
        campusId: e.campusId,
        programme,
        provider: dto.provider?.trim() || null,
        hours: dto.hours,
        status: dto.status,
        completedOn: completedOn ? dateOf(completedOn) : null,
        isMandatory,
        createdById: user.id,
      })),
    });
    if (!completed) {
      await this.wf.notifyEmployees(ids, {
        category: 'Information', topic: 'events', module: 'workforce', title: `Training scheduled: ${programme}`,
        body: `${dto.hours} hour${dto.hours === 1 ? '' : 's'}${dto.provider ? ` with ${dto.provider.trim()}` : ''}.`, route: '/staff-self',
      });
    }
    await this.audit.record({
      user, action: 'create', module: 'workforce', entityType: 'cpd', entityId: programme,
      description: `${completed ? 'Logged completed' : `Scheduled (${dto.status})`} training "${programme}" (${dto.hours} h) for ${emps.length} employee${emps.length === 1 ? '' : 's'}`, req,
    });
    return ok({ created: emps.length }, `${programme} ${completed ? 'logged' : 'scheduled'} for ${emps.length} employee${emps.length === 1 ? '' : 's'}`);
  }

  @Patch('cpd/:id')
  @RequirePermissions('hr.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CpdPatchDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.prisma.workforceCpdRecord.findUnique({ where: { id } });
    if (!r) throw notFound('Training record');
    const status = dto.status ?? r.status;
    let completedOn = dto.completedOn !== undefined ? dto.completedOn?.slice(0, 10) ?? null : keyOrNull(r.completedOn);
    if (status === 'Completed' && !completedOn) completedOn = todayKey();
    if (status !== 'Completed') completedOn = null;
    if (completedOn && completedOn > todayKey()) throw fieldError('completedOn', 'Cannot be in the future');
    if (dto.status === undefined && dto.completedOn === undefined && dto.hours === undefined) throw badRequest('Nothing to change');
    await this.prisma.workforceCpdRecord.update({
      where: { id },
      data: { status, completedOn: completedOn ? dateOf(completedOn) : null, ...(dto.hours !== undefined ? { hours: dto.hours } : {}) },
    });
    const emp = await this.prisma.employee.findUnique({ where: { id: r.employeeId }, select: { fullName: true } });
    await this.audit.record({
      user, action: 'update', module: 'workforce', entityType: 'cpd', entityId: id, campusId: r.campusId,
      description: `${r.programme} for ${emp?.fullName ?? ''}: ${r.status} → ${status}${completedOn ? ` (${completedOn})` : ''}`, req,
    });
    return ok({ id, status, completedOn }, status === 'Completed' ? 'Marked as completed' : 'Training updated');
  }
}
