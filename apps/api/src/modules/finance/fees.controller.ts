import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Matches, MaxLength, MinLength,
} from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, notFound } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { FinanceFeesService } from './fees.service';
import { COUNTER_METHODS, dateOnly, inr, isoDate, num, r2, STRUCTURE_STATUSES, TERMS, uuidOr404 } from './finance.util';
import { FinanceLedgerService } from './ledger.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class StructureQuery extends ListQuery {
  @IsOptional() @IsString() feeHeadId?: string;
  @IsOptional() @IsIn(STRUCTURE_STATUSES) status?: string;
}

class CreateStructureDto {
  @IsArray() @ArrayMinSize(1, { message: 'Choose at least one class.' }) @ArrayMaxSize(200) @IsUUID('all', { each: true, message: 'Choose at least one class.' })
  classIds: string[];
  @IsUUID('all', { message: 'Choose a fee head.' }) feeHeadId: string;
  @IsIn(TERMS, { message: 'Choose an instalment.' }) term: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter the amount per instalment.' }) @IsPositive({ message: 'Enter the amount per instalment.' })
  amount: number;
  @Matches(DATE, { message: 'Choose a due date.' }) dueDate: string;
  @IsOptional() @IsIn(['Active', 'Draft']) status: string = 'Active';
  @IsOptional() @IsBoolean() applyNow?: boolean;
}

class UpdateStructureDto {
  @IsOptional() @IsIn(STRUCTURE_STATUSES) status?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter the amount per instalment.' }) @IsPositive({ message: 'Enter the amount per instalment.' })
  amount?: number;
  @IsOptional() @Matches(DATE, { message: 'Choose a due date.' }) dueDate?: string;
}

class AccountQuery extends ListQuery {
  @IsOptional() @IsIn(['Overdue', 'Partial', 'Pending', 'Paid', 'No charges']) feeStatus?: string;
  @IsOptional() @IsUUID() classId?: string;
}

class ChargeDto {
  @IsUUID('all', { message: 'Choose a fee head.' }) feeHeadId: string;
  @IsString() @MinLength(3, { message: 'Describe the charge.' }) @MaxLength(160) description: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter an amount greater than zero.' }) @IsPositive({ message: 'Enter an amount greater than zero.' })
  amount: number;
  @Matches(DATE, { message: 'Choose a due date.' }) dueDate: string;
}

class PaymentDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter an amount greater than zero (up to 2 decimals).' }) @IsPositive({ message: 'Enter an amount greater than zero (up to 2 decimals).' })
  amount: number;
  @IsIn(COUNTER_METHODS, { message: 'Choose a payment method.' }) method: string;
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) feeIds?: string[];
}

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class ReminderDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) studentIds?: string[];
  @IsOptional() @IsIn(['overdue30', 'outstanding', 'due7']) audience?: string;
  @IsIn(['whatsapp_app', 'whatsapp', 'sms_app'], { message: 'Choose a channel.' }) channel: string;
  @IsString() @MinLength(10, { message: 'Write a message of at least 10 characters.' }) @MaxLength(600) message: string;
  @IsOptional() @IsString() campusId?: string;
}

/** Fee structures, student accounts (ledger), counter payments, the fee collection dashboard and reminders. */
@Controller('finance')
@RequirePermissions('finance.read')
export class FinanceFeesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly fees: FinanceFeesService,
    private readonly ledger: FinanceLedgerService,
  ) {}

  @Get('lookups')
  @RequirePermissions('finance.read', 'hr.read', 'hr.manage')
  lookups() {
    return this.fees.lookups();
  }

  // ---- Fee structures -------------------------------------------------------

  @Get('fee-structures/summary')
  structureSummary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    return this.fees.structureSummary(user, q.campusId);
  }

  @Get('fee-structures')
  async structures(@Query() q: StructureQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const rows = await this.fees.structureList(user, q);
    return paged(rows.slice(p.skip, p.skip + p.take).map(({ headOrder: _h, gradeLevel: _g, ...r }) => r), rows.length, p);
  }

  @Post('fee-structures')
  @RequirePermissions('finance.manage')
  async createStructure(@Body() dto: CreateStructureDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.fees.createStructure(user, dto);
    await this.audit.record({
      user, action: 'create', module: 'finance', entityType: 'finance_fee_structure', entityId: r.ids[0], req,
      description: `Created fee structure ${r.head} ${dto.term} ${inr(dto.amount)} for ${r.classes.join(', ')}${r.applied ? ` and raised it on ${r.applied} account(s)` : ''}`,
    });
    return ok({ ids: r.ids, applied: r.applied }, `Structure created${r.applied ? ` and raised on ${r.applied} account(s)` : ''}`);
  }

  @Patch('fee-structures/:id')
  @RequirePermissions('finance.manage')
  async updateStructure(@Param('id') id: string, @Body() dto: UpdateStructureDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const s = await this.prisma.financeFeeStructure.findUnique({ where: { id: uuidOr404(id, 'Fee structure line') }, include: { feeHead: true, _count: { select: { charges: true } } } });
    if (!s) throw notFound('Fee structure line');
    this.assertCampus(user, s.campusId);
    if (s.status === 'Archived' && dto.status && dto.status !== 'Archived') throw badRequest('Archived structure lines cannot be reactivated. Create a new line instead.');
    if ((dto.amount != null && r2(dto.amount) !== num(s.amount)) || (dto.dueDate && dto.dueDate !== isoDate(s.dueDate))) {
      if (s._count.charges > 0) throw badRequest('This line has already been raised on student accounts. Archive it and create a new line to change the amount or due date.');
    }
    const updated = await this.prisma.financeFeeStructure.update({
      where: { id: s.id },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.amount != null ? { amount: r2(dto.amount) } : {}),
        ...(dto.dueDate ? { dueDate: dateOnly(dto.dueDate) } : {}),
      },
    });
    await this.audit.record({
      user, action: 'update', module: 'finance', entityType: 'finance_fee_structure', entityId: s.id, campusId: s.campusId, req,
      description: `Fee structure ${s.feeHead.name} ${s.term}${dto.status && dto.status !== s.status ? ` marked ${dto.status}` : ' updated'}`,
    });
    return ok({ id: updated.id, status: updated.status }, dto.status ? `Structure marked ${dto.status}` : 'Structure updated');
  }

  @Post('fee-structures/:id/apply')
  @HttpCode(200)
  @RequirePermissions('finance.manage')
  async applyStructure(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const s = await this.prisma.financeFeeStructure.findUnique({ where: { id: uuidOr404(id, 'Fee structure line') }, include: { feeHead: true } });
    if (!s) throw notFound('Fee structure line');
    this.assertCampus(user, s.campusId);
    const n = await this.fees.applyStructure(s.id, user);
    await this.audit.record({
      user, action: 'update', module: 'finance', entityType: 'finance_fee_structure', entityId: s.id, campusId: s.campusId, req,
      description: `Applied ${s.feeHead.name} ${s.term} to ${n} student account(s)`,
    });
    return ok({ applied: n }, n ? `${s.feeHead.name} ${s.term} raised on ${n} account(s)` : 'Every enrolled student in this class already has this charge');
  }

  // ---- Fee collection dashboard and reminders -------------------------------

  @Get('fees/summary')
  feeSummary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    return this.fees.dashboard(user, q.campusId);
  }

  @Get('fees/reminders/audience')
  audience(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    return this.fees.audience(user, q.campusId);
  }

  @Post('fees/reminders')
  @HttpCode(200)
  @RequirePermissions('finance.manage')
  async reminders(@Body() dto: ReminderDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!dto.studentIds?.length && !dto.audience) throw badRequest('Choose who should receive the reminder');
    const r = await this.fees.sendReminders(user, dto);
    await this.audit.record({
      user, action: 'create', module: 'finance', entityType: 'finance_reminder', entityId: r.students.length === 1 ? r.students[0] : undefined, req,
      description: `Sent fee reminders to the parents of ${r.sent} student(s) (${dto.audience ?? 'selected'}, ${dto.channel})`,
    });
    return ok({ sent: r.sent }, `Reminders sent to the parents of ${r.sent} student${r.sent === 1 ? '' : 's'}`);
  }

  // ---- Student accounts -------------------------------------------------------

  @Get('accounts')
  async accounts(@Query() q: AccountQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const rows = await this.fees.accountList(user, q);
    return paged(rows.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  @Get('accounts/:id')
  @RequirePermissions('finance.read', 'fees.pay_own')
  async account(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.scope.assertStudent(user, uuidOr404(id, 'Student'));
    return this.ledger.account(id);
  }

  @Post('accounts/:id/charges')
  @RequirePermissions('finance.manage')
  async charge(@Param('id') id: string, @Body() dto: ChargeDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.scope.assertStudent(user, uuidOr404(id, 'Student'));
    const r = await this.fees.raiseCharge(user, id, dto);
    await this.audit.record({
      user, action: 'create', module: 'finance', entityType: 'finance_charge', entityId: r.charge.id, campusId: r.info.campusId, req,
      description: `Raised ${r.head} charge "${r.charge.description}" of ${inr(dto.amount)} on ${r.info.fullName} (${r.info.admissionNo})`,
    });
    return ok({ id: r.charge.id }, `Charge raised on ${r.info.fullName}'s account`);
  }

  @Post('accounts/:id/payments')
  @RequirePermissions('finance.manage')
  async payment(@Param('id') id: string, @Body() dto: PaymentDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.scope.assertStudent(user, uuidOr404(id, 'Student'));
    const p = await this.ledger.recordPayment({
      studentId: id, amount: dto.amount, instrument: dto.method, reference: dto.reference, feeIds: dto.feeIds, source: 'counter',
      collectedBy: { id: user.id, fullName: user.fullName },
    });
    await this.audit.record({
      user, action: 'create', module: 'finance', entityType: 'finance_payment', entityId: p.id, campusId: p.campusId, req,
      description: `Recorded ${dto.method} payment of ${inr(num(p.amount))} — receipt ${p.receiptNo}`,
    });
    return ok({ id: p.id, receiptNo: p.receiptNo }, `Payment of ${inr(num(p.amount))} recorded — receipt ${p.receiptNo}`);
  }

  private assertCampus(user: AuthUser, campusId: string) {
    const allowed = this.scope.campus(user, undefined);
    if (allowed && allowed !== campusId) throw notFound('Fee structure line');
  }
}
