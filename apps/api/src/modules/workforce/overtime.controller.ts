import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { fieldError } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { OvertimeService } from './overtime.service';
import { WorkforceService } from './workforce.service';
import { OT_OPEN, addMonths, dateOf, groupBy, keyOf, monthEndKey, monthShort, monthStartKey, num, round, sortRows, sumBy, todayKey } from './workforce.util';

export class ClaimDto {
  @IsDateString({}, { message: 'Choose a date up to today' }) workDate: string;
  @Type(() => Number) @IsNumber({}, { message: 'Between 0.5 and 16, in half-hour steps' }) @Min(0.5, { message: 'Between 0.5 and 16, in half-hour steps' }) @Max(16, { message: 'Between 0.5 and 16, in half-hour steps' }) hours: number;
  @IsString() @MinLength(3, { message: 'Say what the overtime covered' }) @MaxLength(300) reason: string;
}

class HrClaimDto extends ClaimDto {
  @IsUUID('all', { message: 'Choose the employee' }) employeeId: string;
  @IsOptional() @Type(() => Number) @IsNumber({}, { message: 'Enter a valid rate' }) @Min(0, { message: 'Enter a valid rate' }) @Max(100000) ratePerHour?: number;
}

class OvertimeQuery extends ListQuery {
  @IsOptional() @IsIn(['open', ...OT_OPEN, 'Approved', 'Paid', 'Rejected']) status?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}$/, { message: 'Use YYYY-MM' }) month?: string;
  @IsOptional() @IsString() department?: string;
}

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class NoteDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

const PAYABLE = ['Approved', 'Paid'];

/** Overtime register, monthly summary and the approve / reject decisions. */
@Controller('workforce')
export class OvertimeController {
  constructor(
    private readonly wf: WorkforceService,
    private readonly overtime: OvertimeService,
  ) {}

  private get prisma() {
    return this.wf.prisma;
  }

  @Get('overtime/summary')
  @RequirePermissions('hr.read')
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.wf.campus(user, q.campusId);
    const today = todayKey();
    const from = addMonths(today, -5);
    const rows = await this.prisma.workforceOvertime.findMany({
      where: { ...(campusId ? { campusId } : {}), workDate: { gte: dateOf(from), lte: dateOf(monthEndKey(today)) }, status: { not: 'Rejected' } },
      select: { employeeId: true, workDate: true, hours: true, cost: true, status: true },
    });
    const thisMonth = rows.filter((r) => monthStartKey(keyOf(r.workDate)) === monthStartKey(today));
    const emps = await this.wf.employeesByIds(thisMonth.map((r) => r.employeeId));
    const open = thisMonth.filter((r) => OT_OPEN.includes(r.status));
    const payable = thisMonth.filter((r) => PAYABLE.includes(r.status));
    const byDept = groupBy(thisMonth, (r) => emps.get(r.employeeId)?.department ?? 'Other');
    const byMonth = groupBy(rows, (r) => monthStartKey(keyOf(r.workDate)));
    return {
      kpis: {
        hours: round(sumBy(thisMonth, (r) => num(r.hours)), 1),
        employees: new Set(thisMonth.map((r) => r.employeeId)).size,
        approvedHours: round(sumBy(payable, (r) => num(r.hours)), 1),
        pendingCount: open.length,
        pendingHours: round(sumBy(open, (r) => num(r.hours)), 1),
        cost: round(sumBy(payable, (r) => num(r.cost)), 2),
      },
      byDepartment: [...byDept.entries()]
        .map(([label, list]) => ({ label, value: round(sumBy(list, (r) => num(r.hours)), 1) }))
        .sort((a, b) => b.value - a.value),
      trend: Array.from({ length: 6 }, (_, i) => addMonths(today, i - 5)).map((m) => ({
        label: monthShort(m),
        value: round(sumBy(byMonth.get(m) ?? [], (r) => num(r.hours)), 1),
      })),
    };
  }

  @Get('overtime')
  @RequirePermissions('hr.read')
  async list(@Query() q: OvertimeQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.wf.campus(user, q.campusId);
    const where: Prisma.WorkforceOvertimeWhereInput = {
      ...(campusId ? { campusId } : {}),
      ...(q.status === 'open' ? { status: { in: OT_OPEN } } : q.status ? { status: q.status } : {}),
      ...(q.month ? { workDate: { gte: dateOf(`${q.month}-01`), lte: dateOf(monthEndKey(`${q.month}-01`)) } } : {}),
    };
    const and: Prisma.WorkforceOvertimeWhereInput[] = [];
    if (q.department) {
      const ids = (await this.prisma.employee.findMany({ where: { department: q.department }, select: { id: true } })).map((e) => e.id);
      and.push({ employeeId: { in: ids } });
    }
    if (q.q) {
      const ids = (await this.prisma.employee.findMany({ where: { OR: [{ fullName: like(q.q) }, { code: like(q.q) }] }, select: { id: true } })).map((e) => e.id);
      and.push({ OR: [{ employeeId: { in: ids } }, { reason: like(q.q) }] });
    }
    if (and.length) where.AND = and;
    const claims = await this.prisma.workforceOvertime.findMany({ where, orderBy: [{ workDate: 'desc' }, { createdAt: 'desc' }] });
    let rows = await this.overtime.rows(claims);
    const keys: Record<string, (r: (typeof rows)[number]) => string | number | null> = {
      date: (r) => `${r.workDate}|${r.createdAt}`,
      name: (r) => r.employeeName,
      department: (r) => r.department,
      hours: (r) => r.hours,
      cost: (r) => r.cost,
      status: (r) => r.status,
    };
    const key = q.sort && keys[q.sort] ? q.sort : 'date';
    rows = sortRows(rows, keys[key], q.dir ?? (key === 'date' ? 'desc' : 'asc'));
    return paged(rows.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  @Post('overtime')
  @RequirePermissions('hr.manage')
  async create(@Body() dto: HrClaimDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const emp = await this.prisma.employee.findUnique({ where: { id: dto.employeeId } });
    if (!emp) throw fieldError('employeeId', 'Choose the employee');
    const campusId = this.wf.campus(user, null);
    if (campusId && emp.campusId !== campusId && !user.permissions.has('dashboard.group')) throw fieldError('employeeId', 'This employee is on another campus');
    const row = await this.overtime.create(emp, dto, user, 'hr', req);
    return ok({ id: row.id }, `Overtime recorded for ${emp.fullName} — ${num(row.hours)} h awaiting approval`);
  }

  @Post('overtime/:id/approve')
  @HttpCode(200)
  @RequirePermissions('hr.approve')
  async approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const o = await this.overtime.find(id, user);
    const name = await this.overtime.approve(o, user, req);
    return ok({ id }, `Approved ${num(o.hours)} h for ${name} — included in the next payroll run`);
  }

  @Post('overtime/:id/reject')
  @HttpCode(200)
  @RequirePermissions('hr.approve')
  async reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const o = await this.overtime.find(id, user);
    await this.overtime.reject(o, dto.note ?? '', user, req);
    return ok({ id }, 'Overtime claim rejected');
  }
}
