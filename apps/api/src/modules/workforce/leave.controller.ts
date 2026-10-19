import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { fieldError, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { LeaveService } from './leave.service';
import { WorkforceService } from './workforce.service';
import { LEAVE_OPEN, addMonths, dateOf, groupBy, keyOf, monthEndKey, monthShort, monthStartKey, mondayOf, round, sortRows, sumBy, todayKey } from './workforce.util';

export class LeaveDto {
  @IsUUID('all', { message: 'Choose a leave type' }) leaveTypeId: string;
  @IsDateString({}, { message: 'Required' }) fromDate: string;
  @IsDateString({}, { message: 'Required' }) toDate: string;
  @IsOptional() @IsBoolean() halfDay?: boolean;
  @IsString() @MinLength(3, { message: 'Give a short reason' }) @MaxLength(500) reason: string;
  @IsOptional() @IsString() @MaxLength(120) coverArrangement?: string | null;
}

class HrLeaveDto extends LeaveDto {
  @IsUUID('all', { message: 'Choose the employee' }) employeeId: string;
}

class LeaveQuery extends ListQuery {
  @IsOptional() @IsIn(['open', ...LEAVE_OPEN, 'Approved', 'Rejected', 'Cancelled', 'Draft']) status?: string;
  @IsOptional() @IsUUID() leaveTypeId?: string;
  @IsOptional() @IsIn(['teaching', 'non_teaching']) employeeType?: string;
}

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class NoteDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class CoverDto {
  @IsOptional() @IsString() @MaxLength(120) coverArrangement?: string | null;
}

/** Leave types, the leave register, and the review / approve / reject / cover actions (HR). */
@Controller('workforce')
export class LeaveController {
  constructor(
    private readonly wf: WorkforceService,
    private readonly leave: LeaveService,
  ) {}

  private get prisma() {
    return this.wf.prisma;
  }

  @Get('leave-types')
  @RequirePermissions('hr.read', 'hr.manage')
  async types() {
    const rows = await this.wf.leaveTypes();
    return rows.map((t) => ({ id: t.id, code: t.code, name: t.name, entitlementDays: t.entitlementDays, isPaid: t.isPaid }));
  }

  @Get('leave-requests/summary')
  @RequirePermissions('hr.read')
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.wf.campus(user, q.campusId);
    const scope: Prisma.WorkforceLeaveRequestWhereInput = campusId ? { campusId } : {};
    const today = todayKey();
    const sixFrom = addMonths(today, -5);
    const [types, open, approvedThisWeek, recent, year] = await Promise.all([
      this.wf.leaveTypes(),
      this.prisma.workforceLeaveRequest.findMany({ where: { ...scope, status: { in: LEAVE_OPEN } }, select: { status: true, coverArrangement: true } }),
      this.prisma.workforceLeaveRequest.count({ where: { ...scope, status: 'Approved', decidedAt: { gte: dateOf(mondayOf(today)) } } }),
      this.prisma.workforceLeaveRequest.findMany({
        where: { ...scope, status: 'Approved', fromDate: { gte: dateOf(sixFrom), lte: dateOf(monthEndKey(today)) } },
        select: { fromDate: true, days: true },
      }),
      this.wf.yearWindow(),
    ]);
    const inYear = await this.prisma.workforceLeaveRequest.groupBy({
      by: ['leaveTypeId'],
      where: { ...scope, status: 'Approved', fromDate: { gte: dateOf(year.from), lte: dateOf(year.to) } },
      _sum: { days: true },
    });
    const byMonthMap = groupBy(recent, (r) => monthStartKey(keyOf(r.fromDate)));
    const byMonth = Array.from({ length: 6 }, (_, i) => addMonths(today, i - 5)).map((m) => ({
      label: monthShort(m),
      value: round(sumBy(byMonthMap.get(m) ?? [], (r) => r.days), 1),
    }));
    const typeName = new Map(types.map((t) => [t.id, t.name]));
    const typeMix = inYear
      .map((g) => ({ label: typeName.get(g.leaveTypeId) ?? 'Other', value: round(g._sum.days ?? 0, 1) }))
      .filter((m) => m.value > 0)
      .sort((a, b) => b.value - a.value);
    return {
      counts: {
        submitted: open.filter((r) => r.status === 'Submitted').length,
        underReview: open.filter((r) => r.status === 'Under Review').length,
        approvedThisWeek,
        noCover: open.filter((r) => !r.coverArrangement).length,
      },
      types: types.map((t) => ({ id: t.id, name: t.name })),
      byMonth,
      typeMix,
      totalDays: round(sumBy(typeMix, (m) => m.value), 1),
    };
  }

  @Get('leave-requests')
  @RequirePermissions('hr.read')
  async list(@Query() q: LeaveQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.wf.campus(user, q.campusId);
    const where: Prisma.WorkforceLeaveRequestWhereInput = {
      ...(campusId ? { campusId } : {}),
      ...(q.status === 'open' ? { status: { in: LEAVE_OPEN } } : q.status ? { status: q.status } : {}),
      ...(q.leaveTypeId ? { leaveTypeId: q.leaveTypeId } : {}),
    };
    if (q.employeeType || q.q) {
      const emps = await this.prisma.employee.findMany({
        where: {
          ...(q.employeeType ? { employeeType: q.employeeType } : {}),
          ...(q.q ? { OR: [{ fullName: like(q.q) }, { code: like(q.q) }] } : {}),
        },
        select: { id: true },
      });
      const ids = emps.map((e) => e.id);
      where.AND = [q.q && !q.employeeType ? { OR: [{ employeeId: { in: ids } }, { code: like(q.q) }] } : { employeeId: { in: ids } }];
    }
    const requests = await this.prisma.workforceLeaveRequest.findMany({ where, include: { leaveType: true }, orderBy: { createdAt: 'desc' } });
    let rows = await this.leave.rows(requests);
    const codeNo = (c: string) => Number(c.replace(/\D/g, '')) || 0;
    const keys: Record<string, (r: (typeof rows)[number]) => string | number | null> = {
      code: (r) => codeNo(r.code),
      name: (r) => r.employeeName,
      from: (r) => r.fromDate,
      to: (r) => r.toDate,
      days: (r) => r.days,
      status: (r) => r.status,
      type: (r) => r.leaveType,
    };
    rows = sortRows(rows, keys[q.sort ?? ''] ?? keys.code, q.sort && keys[q.sort] ? q.dir ?? 'asc' : q.dir ?? 'desc');
    return paged(rows.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  /** HR records a request on behalf of an employee. */
  @Post('leave-requests')
  @RequirePermissions('hr.manage')
  async create(@Body() dto: HrLeaveDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const emp = await this.prisma.employee.findUnique({ where: { id: dto.employeeId } });
    if (!emp) throw fieldError('employeeId', 'Choose the employee');
    const campusId = this.wf.campus(user, null);
    if (campusId && emp.campusId !== campusId && !user.permissions.has('dashboard.group')) throw fieldError('employeeId', 'This employee is on another campus');
    const row = await this.leave.create(emp, dto, user, 'hr', req);
    return ok({ id: row.id, code: row.code }, `Leave request ${row.code} recorded for ${emp.fullName} — awaiting review`);
  }

  @Post('leave-requests/:id/review')
  @HttpCode(200)
  @RequirePermissions('hr.approve')
  async review(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.leave.find(id, user);
    await this.leave.review(r, user, req);
    return ok({ id }, `${r.code} is now under review`);
  }

  @Post('leave-requests/:id/approve')
  @HttpCode(200)
  @RequirePermissions('hr.approve')
  async approve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.leave.find(id, user);
    const { flagged } = await this.leave.approve(r, dto.note, user, req);
    return ok({ id }, `${r.code} approved${flagged ? ` — ${flagged} roster line${flagged === 1 ? '' : 's'} flagged for cover` : ''}`);
  }

  @Post('leave-requests/:id/reject')
  @HttpCode(200)
  @RequirePermissions('hr.approve')
  async reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.leave.find(id, user);
    await this.leave.reject(r, dto.note ?? '', user, req);
    return ok({ id }, `${r.code} rejected`);
  }

  @Patch('leave-requests/:id')
  @RequirePermissions('hr.manage')
  async cover(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CoverDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.leave.find(id, user);
    if (!r) throw notFound('Leave request');
    await this.leave.setCover(r, dto.coverArrangement ?? null, user, req);
    return ok({ id }, 'Cover arrangement updated');
  }
}
