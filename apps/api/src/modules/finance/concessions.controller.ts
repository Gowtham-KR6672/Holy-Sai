import { Body, Controller, Get, HttpCode, Logger, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, conflict, fieldError, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AWARD_TYPES, CONCESSION_TYPES, firstName, inr, isoDate, num, OPEN_APPROVAL, r2, sortRows, uuidOr404 } from './finance.util';
import { FinanceLedgerService, type FinanceYear } from './ledger.service';

class ConcessionQuery extends ListQuery {
  @IsOptional() @IsIn(['Submitted', 'Under Review', 'Approved', 'Rejected']) status?: string;
  @IsOptional() @IsIn(CONCESSION_TYPES) type?: string;
  /** scholarship = merit, need-based and sports awards only */
  @IsOptional() @IsIn(['scholarship', 'concession']) group?: string;
  @IsOptional() @IsUUID() studentId?: string;
}

class ConcessionDto {
  @IsUUID('all', { message: 'Choose a student.' }) studentId: string;
  @IsIn(CONCESSION_TYPES, { message: 'Choose a concession type.' }) type: string;
  @IsString() @MinLength(3, { message: 'Explain the basis for this concession.' }) @MaxLength(500) reason: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter a value greater than zero.' }) @IsPositive({ message: 'Enter a value greater than zero.' })
  @Max(100, { message: 'A percentage cannot exceed 100.' })
  percent?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter a value greater than zero.' }) @IsPositive({ message: 'Enter a value greater than zero.' })
  amount?: number;
  @IsOptional() @IsUUID() scholarshipId?: string;
}

class ReasonDto {
  @IsString() @MinLength(3, { message: 'Please give a reason (at least 3 characters).' }) @MaxLength(500) reason: string;
}

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class RoundDto {
  @IsString() @MinLength(3, { message: 'Name the scholarship.' }) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(500) criteria?: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter the award value.' }) @IsPositive({ message: 'Enter the award value.' }) amount: number;
  @Type(() => Number) @IsInt({ message: 'Enter the number of seats (1 or more).' }) @Min(1, { message: 'Enter the number of seats (1 or more).' }) @Max(10000) seats: number;
}

class UpdateRoundDto {
  @IsOptional() @IsIn(['Open', 'Closed']) status?: string;
  @IsOptional() @IsString() @MinLength(3, { message: 'Name the scholarship.' }) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) criteria?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive({ message: 'Enter the award value.' }) amount?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1, { message: 'Enter the number of seats (1 or more).' }) seats?: number;
}

const KEYWORD: Record<string, RegExp> = { 'Merit scholarship': /merit/i, 'Need-based support': /need|means|financial/i, 'Sports quota': /sport/i };

/** Concessions and scholarships: request, review, approve (applied to the student's charges) or reject; scholarship rounds. */
@Controller('finance')
@RequirePermissions('finance.read')
export class FinanceConcessionsController {
  private readonly log = new Logger('Finance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly ledger: FinanceLedgerService,
  ) {}

  private yearWhere(y: FinanceYear): Prisma.FinanceConcessionWhereInput {
    return y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null, createdAt: { gte: y.start } }] } : { createdAt: { gte: y.start } };
  }

  @Get('concessions/summary')
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const y = await this.ledger.year();
    const [rows, tuition] = await Promise.all([
      this.prisma.financeConcession.findMany({
        where: { ...(campusId ? { campusId } : {}), ...this.yearWhere(y) },
        select: { type: true, status: true, amount: true, studentId: true },
      }),
      this.prisma.financeCharge.aggregate({
        where: { ...(campusId ? { campusId } : {}), feeHead: { name: 'Tuition' }, ...this.ledger.yearWhere(y) },
        _sum: { amount: true },
      }),
    ]);
    const types = CONCESSION_TYPES.map((type) => {
      const list = rows.filter((r) => r.type === type);
      const approved = list.filter((r) => r.status === 'Approved');
      return {
        type,
        students: new Set(approved.map((r) => r.studentId)).size,
        value: r2(approved.reduce((s, r) => s + num(r.amount), 0)),
        pending: list.filter((r) => OPEN_APPROVAL.includes(r.status)).length,
      };
    });
    const awards = rows.filter((r) => AWARD_TYPES.includes(r.type));
    const approvedAwards = awards.filter((r) => r.status === 'Approved');
    return {
      types,
      tuitionBilled: num(tuition._sum.amount),
      scholarships: {
        awards: approvedAwards.length,
        value: r2(approvedAwards.reduce((s, r) => s + num(r.amount), 0)),
        underReview: awards.filter((r) => OPEN_APPROVAL.includes(r.status)).length,
      },
      academicYear: y.label,
    };
  }

  @Get('concessions')
  async list(@Query() q: ConcessionQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.scope.campus(user, q.campusId);
    const y = await this.ledger.year();
    const term = q.q?.trim();
    const students = term
      ? await this.prisma.student.findMany({ where: { OR: [{ fullName: like(term) }, { admissionNo: like(term) }] }, select: { id: true }, take: 500 })
      : [];
    const where: Prisma.FinanceConcessionWhereInput = {
      AND: [
        this.yearWhere(y),
        campusId ? { campusId } : {},
        q.status ? { status: q.status } : {},
        q.type ? { type: q.type } : {},
        q.studentId ? { studentId: q.studentId } : {},
        q.group === 'scholarship' ? { type: { in: AWARD_TYPES } } : q.group === 'concession' ? { type: { notIn: AWARD_TYPES } } : {},
        term ? { OR: [{ reason: like(term) }, { type: like(term) }, { studentId: { in: students.map((s) => s.id) } }] } : {},
      ],
    };
    const rows = await this.prisma.financeConcession.findMany({ where, include: { scholarship: { select: { name: true } } }, orderBy: { createdAt: 'desc' } });
    const info = await this.ledger.studentInfo(rows.map((r) => r.studentId));
    let out = rows.map((r) => {
      const s = info.get(r.studentId);
      return {
        id: r.id,
        studentId: r.studentId,
        studentName: s?.fullName ?? 'Student',
        admissionNo: s?.admissionNo ?? '',
        grade: s?.grade ?? null,
        section: s?.section ?? null,
        campus: s?.campus ?? '',
        type: r.type,
        reason: r.reason,
        amount: num(r.amount),
        percent: r.percent == null ? null : num(r.percent),
        appliedAmount: num(r.appliedAmount),
        status: r.status,
        requestedBy: r.requestedBy,
        reviewedBy: r.reviewedBy,
        decidedBy: r.decidedBy,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        rejectionReason: r.rejectionReason,
        validUntil: isoDate(r.validUntil),
        scholarshipId: r.scholarshipId,
        scholarship: r.scholarship?.name ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    });
    const dir = q.dir ?? 'desc';
    switch (q.sort) {
      case 'student': out = sortRows(out, (r) => r.studentName, dir); break;
      case 'type': out = sortRows(out, (r) => r.type, dir); break;
      case 'amount': out = sortRows(out, (r) => r.amount, dir); break;
      case 'status': out = sortRows(out, (r) => r.status, dir); break;
      default: out = sortRows(out, (r) => r.createdAt, dir);
    }
    return paged(out.slice(p.skip, p.skip + p.take), out.length, p);
  }

  @Post('concessions')
  @RequirePermissions('finance.manage')
  async create(@Body() dto: ConcessionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.scope.assertStudent(user, dto.studentId);
    const info = (await this.ledger.studentInfo([dto.studentId])).get(dto.studentId);
    if (!info) throw fieldError('studentId', 'Choose a student.');
    if (dto.percent == null && dto.amount == null) throw fieldError('amount', 'Enter a value greater than zero.');
    const y = await this.ledger.year();
    const dup = await this.prisma.financeConcession.findFirst({
      where: { studentId: dto.studentId, type: dto.type, status: { in: [...OPEN_APPROVAL, 'Approved'] }, ...this.yearWhere(y) },
    });
    if (dup) throw fieldError('type', `${info.fullName} already has a ${dto.type.toLowerCase()} ${dup.status === 'Approved' ? 'approved' : 'awaiting a decision'} this year.`);
    let amount: number;
    if (dto.percent != null) {
      const tuition = await this.ledger.tuitionBilled(dto.studentId);
      if (tuition <= 0) throw fieldError('percent', 'No tuition has been billed to this student yet, so a percentage has no value. Enter a fixed amount instead.');
      amount = r2((tuition * dto.percent) / 100);
    } else {
      amount = r2(dto.amount!);
    }
    const scholarshipId = AWARD_TYPES.includes(dto.type) ? await this.roundFor(dto.type, dto.scholarshipId) : null;
    const c = await this.prisma.financeConcession.create({
      data: {
        studentId: dto.studentId, campusId: info.campusId, academicYearId: y.id, type: dto.type, reason: dto.reason.trim(),
        percent: dto.percent ?? null, amount, status: 'Submitted', scholarshipId, requestedById: user.id, requestedBy: user.fullName,
      },
    });
    await this.notifications.createTaskForPermission('finance.approve', {
      title: `Approve ${dto.type.toLowerCase()} for ${info.fullName} (${inr(amount)})`,
      module: 'finance',
      status: 'Under Review',
      priority: 'Medium',
      route: AWARD_TYPES.includes(dto.type) ? '/scholarships?status=Submitted' : `/concessions?q=${encodeURIComponent(info.admissionNo)}`,
      entityType: 'finance_concession',
      entityId: c.id,
    }, info.campusId);
    await this.audit.record({
      user, action: 'create', module: 'finance', entityType: 'finance_concession', entityId: c.id, campusId: info.campusId, req,
      description: `Requested ${dto.type.toLowerCase()} of ${inr(amount)}${dto.percent != null ? ` (${dto.percent}% of tuition)` : ''} for ${info.fullName} (${info.admissionNo})`,
    });
    return ok({ id: c.id, status: c.status, amount }, 'Concession submitted for approval');
  }

  /** Links a nomination to a scholarship round: the one given, or the open round matching the award type. */
  private async roundFor(type: string, requested?: string): Promise<string | null> {
    if (requested) {
      const r = await this.prisma.financeScholarship.findUnique({ where: { id: requested } });
      if (!r) throw fieldError('scholarshipId', 'Choose a scholarship round.');
      if (r.status !== 'Open') throw fieldError('scholarshipId', `"${r.name}" is closed to nominations.`);
      return r.id;
    }
    const open = await this.prisma.financeScholarship.findMany({ where: { status: 'Open' }, orderBy: { createdAt: 'desc' } });
    const matching = open.filter((r) => KEYWORD[type]?.test(`${r.name} ${r.criteria ?? ''}`));
    if (matching.length === 1) return matching[0].id;
    if (!matching.length && open.length === 1) return open[0].id;
    return null;
  }

  private async load(id: string, user: AuthUser) {
    const c = await this.prisma.financeConcession.findUnique({ where: { id: uuidOr404(id, 'Concession') } });
    if (!c) throw notFound('Concession');
    await this.scope.assertStudent(user, c.studentId);
    return c;
  }

  @Post('concessions/:id/review')
  @HttpCode(200)
  @RequirePermissions('finance.approve')
  async review(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const c = await this.load(id, user);
    if (c.status !== 'Submitted') throw badRequest(c.status === 'Under Review' ? 'This request is already under review' : 'This request has already been decided');
    await this.prisma.financeConcession.update({ where: { id: c.id }, data: { status: 'Under Review', reviewedById: user.id, reviewedBy: user.fullName, reviewedAt: new Date() } });
    await this.audit.record({ user, action: 'update', module: 'finance', entityType: 'finance_concession', entityId: c.id, campusId: c.campusId, req, description: `Took ${c.type.toLowerCase()} request under review` });
    return ok({ id: c.id, status: 'Under Review' }, 'Marked under review');
  }

  @Post('concessions/:id/approve')
  @HttpCode(200)
  @RequirePermissions('finance.approve')
  async approve(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const c = await this.load(id, user);
    if (!OPEN_APPROVAL.includes(c.status)) throw badRequest('This request has already been decided');
    const info = (await this.ledger.studentInfo([c.studentId])).get(c.studentId);
    let amount = num(c.amount);
    if (c.percent != null) {
      const tuition = await this.ledger.tuitionBilled(c.studentId);
      amount = r2((tuition * num(c.percent)) / 100);
      if (amount <= 0) throw badRequest('No tuition is billed to this student this year, so the percentage has no value.');
    }
    if (c.scholarshipId) {
      const round = await this.prisma.financeScholarship.findUnique({ where: { id: c.scholarshipId }, include: { _count: { select: { concessions: { where: { status: 'Approved' } } } } } });
      if (round && round._count.concessions >= round.seats) throw conflict(`All ${round.seats} seats in "${round.name}" are already awarded`);
    }
    const y = await this.ledger.year();
    const applied = await this.prisma.$transaction(async (tx) => {
      await tx.financeConcession.update({
        where: { id: c.id },
        data: { status: 'Approved', amount, decidedById: user.id, decidedBy: user.fullName, decidedAt: new Date(), validUntil: y.end, rejectionReason: null },
      });
      return this.ledger.applyConcession(tx, c.id);
    });
    await this.notifications.completeTasksFor('finance_concession', c.id);
    const name = info?.fullName ?? 'the student';
    await this.notifications
      .notifyGuardians(c.studentId, {
        category: 'Completed', topic: 'fees', module: 'finance', campusId: c.campusId,
        title: `${c.type} approved`,
        body: `A ${c.type.toLowerCase()} of ${inr(amount)} has been approved for ${info ? firstName(info.fullName) : 'your child'} and applied to the fee account.`,
        route: '/parent-360?tab=fees',
      })
      .catch((e) => this.log.warn(`Concession notification failed: ${(e as Error).message}`));
    if (c.requestedById && c.requestedById !== user.id) {
      await this.notifications.notifyUsers([c.requestedById], {
        category: 'Completed', topic: 'fees', module: 'finance', title: `${c.type} approved for ${name}`,
        body: `${user.fullName} approved ${inr(amount)}; ${inr(applied)} was deducted from outstanding charges.`, route: AWARD_TYPES.includes(c.type) ? '/scholarships' : '/concessions',
      });
    }
    await this.audit.record({
      user, action: 'approve', module: 'finance', entityType: 'finance_concession', entityId: c.id, campusId: c.campusId, req,
      description: `Approved ${c.type.toLowerCase()} of ${inr(amount)} for ${name}; ${inr(applied)} applied to outstanding charges`,
    });
    return ok({ id: c.id, status: 'Approved', amount, applied }, `${c.type} approved — ${inr(applied)} deducted from ${name}'s charges`);
  }

  @Post('concessions/:id/reject')
  @HttpCode(200)
  @RequirePermissions('finance.approve')
  async reject(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const c = await this.load(id, user);
    if (!OPEN_APPROVAL.includes(c.status)) throw badRequest('This request has already been decided');
    await this.prisma.financeConcession.update({
      where: { id: c.id },
      data: { status: 'Rejected', decidedById: user.id, decidedBy: user.fullName, decidedAt: new Date(), rejectionReason: dto.reason.trim() },
    });
    await this.notifications.completeTasksFor('finance_concession', c.id);
    const info = (await this.ledger.studentInfo([c.studentId])).get(c.studentId);
    if (c.requestedById && c.requestedById !== user.id) {
      await this.notifications.notifyUsers([c.requestedById], {
        category: 'Information', topic: 'fees', module: 'finance', title: `${c.type} rejected for ${info?.fullName ?? 'a student'}`,
        body: `${user.fullName}: ${dto.reason.trim()}`, route: AWARD_TYPES.includes(c.type) ? '/scholarships' : '/concessions',
      });
    }
    await this.audit.record({
      user, action: 'reject', module: 'finance', entityType: 'finance_concession', entityId: c.id, campusId: c.campusId, req,
      description: `Rejected ${c.type.toLowerCase()} for ${info?.fullName ?? 'student'}: ${dto.reason.trim()}`,
    });
    return ok({ id: c.id, status: 'Rejected' }, `${c.type} rejected`);
  }

  // ---- Scholarship rounds ---------------------------------------------------

  @Get('scholarships')
  async rounds() {
    const y = await this.ledger.year();
    const rows = await this.prisma.financeScholarship.findMany({
      where: y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null }, { status: 'Open' }] } : {},
      include: { _count: { select: { concessions: { where: { status: 'Approved' } } } } },
      orderBy: [{ status: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id, name: r.name, criteria: r.criteria, amount: num(r.amount), seats: r.seats, awarded: r._count.concessions, status: r.status,
      createdAt: r.createdAt.toISOString(), closedAt: r.closedAt?.toISOString() ?? null,
    }));
  }

  @Post('scholarships')
  @RequirePermissions('finance.manage')
  async openRound(@Body() dto: RoundDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const y = await this.ledger.year();
    const dup = await this.prisma.financeScholarship.findFirst({ where: { name: { equals: dto.name.trim(), mode: 'insensitive' }, status: 'Open' } });
    if (dup) throw fieldError('name', 'An open round with this name already exists.');
    const r = await this.prisma.financeScholarship.create({
      data: { academicYearId: y.id, name: dto.name.trim(), criteria: dto.criteria?.trim() || null, amount: r2(dto.amount), seats: dto.seats, createdById: user.id },
    });
    await this.audit.record({ user, action: 'create', module: 'finance', entityType: 'finance_scholarship', entityId: r.id, req, description: `Opened scholarship round "${r.name}" (${dto.seats} seats, ${inr(dto.amount)})` });
    return ok({ id: r.id }, `Scholarship round "${r.name}" opened`);
  }

  @Patch('scholarships/:id')
  @RequirePermissions('finance.manage')
  async updateRound(@Param('id') id: string, @Body() dto: UpdateRoundDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.prisma.financeScholarship.findUnique({
      where: { id: uuidOr404(id, 'Scholarship round') },
      include: { _count: { select: { concessions: { where: { status: 'Approved' } } } } },
    });
    if (!r) throw notFound('Scholarship round');
    if (dto.seats != null && dto.seats < r._count.concessions) throw fieldError('seats', `${r._count.concessions} seats are already awarded.`);
    const updated = await this.prisma.financeScholarship.update({
      where: { id: r.id },
      data: {
        ...(dto.status ? { status: dto.status, closedAt: dto.status === 'Closed' ? new Date() : null } : {}),
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.criteria !== undefined ? { criteria: dto.criteria.trim() || null } : {}),
        ...(dto.amount != null ? { amount: r2(dto.amount) } : {}),
        ...(dto.seats != null ? { seats: dto.seats } : {}),
      },
    });
    await this.audit.record({
      user, action: 'update', module: 'finance', entityType: 'finance_scholarship', entityId: r.id, req,
      description: dto.status && dto.status !== r.status ? `Marked scholarship round "${r.name}" ${dto.status}` : `Updated scholarship round "${r.name}"`,
    });
    return ok({ id: updated.id, status: updated.status }, dto.status ? `Round marked ${dto.status}` : 'Round updated');
  }
}
