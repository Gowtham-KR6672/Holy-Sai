import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res, StreamableFile, type RawBodyRequest } from '@nestjs/common';
import type { FinancePayment, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, Public, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { addDays, dateOnly, inr, isoDate, istDate, istStart, num, PAYMENT_METHODS, PAYMENT_STATUSES, sortRows, todayIso, toCsv, uuidOr404 } from './finance.util';
import { FinanceLedgerService } from './ledger.service';
import { PaymentGatewayService } from './payment-gateway.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class PaymentQuery extends ListQuery {
  @IsOptional() @IsIn(PAYMENT_METHODS) method?: string;
  @IsOptional() @IsIn(PAYMENT_STATUSES) status?: string;
  @IsOptional() @IsIn(['true', 'false']) reconciled?: string;
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsIn(['Delivered', 'Pending']) delivery?: string;
  @IsOptional() @IsUUID() studentId?: string;
}

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class OrderDto {
  @IsUUID() studentId: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive() amount?: number;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) feeIds?: string[];
  @IsOptional() @IsIn(['UPI', 'Card', 'Net Banking']) method?: string;
}

class VerifyDto {
  @IsString() @MaxLength(80) orderId: string;
  @IsString() @MaxLength(80) paymentId: string;
  @IsString() @MaxLength(200) signature: string;
}

/** Payments register, receipts (view, WhatsApp delivery), CSV export, and the online payment gateway. */
@Controller('finance')
@RequirePermissions('finance.read')
export class FinancePaymentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly ledger: FinanceLedgerService,
    private readonly gateway: PaymentGatewayService,
  ) {}

  private async where(user: AuthUser, q: PaymentQuery): Promise<Prisma.FinancePaymentWhereInput> {
    const campusId = this.scope.campus(user, q.campusId);
    const and: Prisma.FinancePaymentWhereInput[] = [];
    if (campusId) and.push({ campusId });
    if (q.studentId) and.push({ studentId: q.studentId });
    if (q.method) and.push({ method: q.method });
    if (q.status) and.push({ status: q.status });
    if (q.reconciled === 'true') and.push({ reconciled: true });
    if (q.reconciled === 'false') and.push({ reconciled: false });
    if (q.from) and.push({ paidAt: { gte: istStart(q.from) } });
    if (q.to) and.push({ paidAt: { lt: istStart(isoDate(addDays(dateOnly(q.to), 1))!) } });
    if (q.delivery === 'Delivered') and.push({ status: 'Success', receiptSentAt: { not: null } });
    if (q.delivery === 'Pending') and.push({ status: 'Success', receiptSentAt: null });
    const term = q.q?.trim();
    if (term) {
      const students = await this.prisma.student.findMany({ where: { OR: [{ fullName: like(term) }, { admissionNo: like(term) }] }, select: { id: true }, take: 500 });
      and.push({ OR: [{ receiptNo: like(term) }, { gatewayRef: like(term) }, { gatewayOrderId: like(term) }, { studentId: { in: students.map((s) => s.id) } }] });
    }
    return { AND: and };
  }

  private async rows(list: FinancePayment[]) {
    const info = await this.ledger.studentInfo(list.map((p) => p.studentId));
    return list.map((p) => {
      const s = info.get(p.studentId);
      return {
        id: p.id,
        receiptNo: p.receiptNo ?? p.gatewayOrderId ?? 'Pending',
        gatewayRef: p.gatewayRef,
        collectedBy: p.collectedBy,
        paidBy: p.paidBy,
        studentId: p.studentId,
        studentName: s?.fullName ?? 'Student',
        admissionNo: s?.admissionNo ?? '',
        grade: s?.grade ?? null,
        section: s?.section ?? null,
        campus: s?.campus ?? '',
        amount: num(p.amount),
        method: p.method,
        instrument: p.instrument,
        source: p.source,
        paidAt: p.paidAt.toISOString(),
        status: p.status,
        failureReason: p.failureReason,
        reconciled: p.reconciled,
        delivery: p.receiptSentAt ? 'Delivered' : 'Pending',
        receiptSentAt: p.receiptSentAt?.toISOString() ?? null,
      };
    });
  }

  @Get('payments')
  async list(@Query() q: PaymentQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const where = await this.where(user, q);
    const dir = q.dir ?? 'desc';
    if (q.sort === 'student') {
      const all = await this.prisma.financePayment.findMany({ where, select: { id: true, studentId: true, paidAt: true } });
      const info = await this.ledger.studentInfo(all.map((x) => x.studentId));
      const ordered = sortRows(sortRows(all, (x) => x.paidAt.getTime(), 'desc'), (x) => info.get(x.studentId)?.fullName, dir);
      const pageIds = ordered.slice(p.skip, p.skip + p.take).map((x) => x.id);
      const rows = await this.prisma.financePayment.findMany({ where: { id: { in: pageIds } } });
      rows.sort((a, b) => pageIds.indexOf(a.id) - pageIds.indexOf(b.id));
      return paged(await this.rows(rows), all.length, p);
    }
    const orderBy: Prisma.FinancePaymentOrderByWithRelationInput[] =
      q.sort === 'receiptNo' ? [{ receiptNo: { sort: dir, nulls: 'last' } }]
        : q.sort === 'amount' ? [{ amount: dir }, { paidAt: 'desc' }]
          : q.sort === 'method' ? [{ method: dir }, { paidAt: 'desc' }]
            : q.sort === 'status' ? [{ status: dir }, { paidAt: 'desc' }]
              : [{ paidAt: dir }];
    const [rows, total] = await Promise.all([
      this.prisma.financePayment.findMany({ where, orderBy, skip: p.skip, take: p.take }),
      this.prisma.financePayment.count({ where }),
    ]);
    return paged(await this.rows(rows), total, p);
  }

  @Get('payments/summary')
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const c = campusId ? { campusId } : {};
    const todayStart = istStart(todayIso());
    const now = new Date();
    const [today, last30, failedOrPending, unreconciled, delivered, pending] = await Promise.all([
      this.prisma.financePayment.aggregate({ where: { ...c, status: 'Success', paidAt: { gte: todayStart } }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.financePayment.aggregate({ where: { ...c, status: 'Success', paidAt: { gte: addDays(now, -30) } }, _sum: { amount: true } }),
      this.prisma.financePayment.count({ where: { ...c, status: { in: ['Failed', 'Initiated'] }, createdAt: { gte: addDays(now, -7) } } }),
      this.prisma.financePayment.count({ where: { ...c, status: 'Success', reconciled: false } }),
      this.prisma.financePayment.count({ where: { ...c, status: 'Success', receiptSentAt: { not: null } } }),
      this.prisma.financePayment.count({ where: { ...c, status: 'Success', receiptSentAt: null } }),
    ]);
    return {
      collectedToday: num(today._sum.amount),
      transactionsToday: today._count._all,
      collected30d: num(last30._sum.amount),
      failedOrPending,
      unreconciled,
      receiptsDelivered: delivered,
      receiptsPending: pending,
    };
  }

  @Get('payments/export')
  async export(@Query() q: PaymentQuery, @CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const where = await this.where(user, q);
    const list = await this.prisma.financePayment.findMany({ where, orderBy: { paidAt: 'desc' }, take: 50_000 });
    const rows = (await this.rows(list)).map((r) => ({
      ...r,
      paidOn: istDate(new Date(r.paidAt)),
      grade: r.grade ? `${r.grade}${r.section ?? ''}` : '',
      reconciled: r.status === 'Success' ? (r.reconciled ? 'Matched' : 'Open') : '',
      delivery: r.status === 'Success' ? r.delivery : '',
      by: r.collectedBy ? `Counter · ${r.collectedBy}` : r.paidBy ?? '',
    }));
    const csv = toCsv(
      [
        { key: 'receiptNo', label: 'Receipt / reference' }, { key: 'paidOn', label: 'Date' }, { key: 'studentName', label: 'Student' },
        { key: 'admissionNo', label: 'Admission No' }, { key: 'grade', label: 'Grade' }, { key: 'campus', label: 'Campus' }, { key: 'amount', label: 'Amount (INR)' },
        { key: 'method', label: 'Method' }, { key: 'instrument', label: 'Instrument' }, { key: 'gatewayRef', label: 'Transaction reference' },
        { key: 'status', label: 'Status' }, { key: 'reconciled', label: 'Bank' }, { key: 'delivery', label: 'Receipt delivery' }, { key: 'by', label: 'Collected / paid by' },
      ],
      rows,
    );
    await this.audit.record({ user, action: 'export', module: 'finance', entityType: 'finance_payment', description: `Exported the payment register (${rows.length} rows)`, req });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payments-${todayIso()}.csv"`);
    return new StreamableFile(Buffer.from(csv, 'utf8'));
  }

  @Get('payments/:id/receipt')
  @RequirePermissions('finance.read', 'fees.pay_own')
  async receipt(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const p = await this.prisma.financePayment.findUnique({ where: { id: uuidOr404(id, 'Receipt') }, select: { studentId: true } });
    if (!p) throw notFound('Receipt');
    await this.scope.assertStudent(user, p.studentId);
    return this.ledger.receipt(id);
  }

  @Post('payments/:id/send-receipt')
  @HttpCode(200)
  @RequirePermissions('finance.manage')
  async sendReceipt(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const p = await this.prisma.financePayment.findUnique({ where: { id: uuidOr404(id, 'Receipt') } });
    if (!p) throw notFound('Receipt');
    await this.scope.assertStudent(user, p.studentId);
    const r = await this.ledger.deliverReceipt(p.id, { throwOnFailure: true });
    await this.audit.record({
      user, action: 'update', module: 'finance', entityType: 'finance_payment', entityId: p.id, campusId: p.campusId, req,
      description: `Sent receipt ${p.receiptNo} to the parent on WhatsApp`,
    });
    return ok({ receiptSentAt: r.sentAt?.toISOString() ?? null }, `Receipt ${p.receiptNo} sent on WhatsApp`);
  }

  // ---- Online payment gateway (Razorpay) -------------------------------------

  @Get('gateway/status')
  @RequirePermissions('finance.read', 'fees.pay_own')
  async gatewayStatus() {
    return { configured: await this.gateway.isConfigured(), provider: 'Razorpay' };
  }

  @Post('gateway/orders')
  @RequirePermissions('finance.manage', 'fees.pay_own')
  async createOrder(@Body() dto: OrderDto, @CurrentUser() user: AuthUser) {
    await this.scope.assertStudent(user, dto.studentId);
    const contact = await this.prisma.user.findUnique({ where: { id: user.id }, select: { email: true, phone: true } });
    const order = await this.gateway.createOrder({
      studentId: dto.studentId, amount: dto.amount, feeIds: dto.feeIds, method: dto.method,
      paidBy: { id: user.id, name: user.fullName, email: contact?.email ?? null, phone: contact?.phone ?? null },
    });
    return ok(order, `Payment of ${inr(order.amount)} started`);
  }

  @Post('gateway/verify')
  @HttpCode(200)
  @RequirePermissions('finance.manage', 'fees.pay_own')
  async verify(@Body() dto: VerifyDto, @CurrentUser() user: AuthUser) {
    const row = await this.prisma.financePayment.findUnique({ where: { gatewayOrderId: dto.orderId }, select: { studentId: true } });
    if (!row) throw notFound('Payment order');
    await this.scope.assertStudent(user, row.studentId);
    const r = await this.gateway.verify(dto);
    return ok(r, `Payment successful — receipt ${r.receiptNo}`);
  }

  /** Razorpay webhook (no sign-in; verified with the webhook secret). */
  @Public()
  @Post('webhooks/razorpay')
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-razorpay-signature') signature?: string) {
    // The signature covers the exact bytes Razorpay sent (main.ts keeps the raw body).
    const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body ?? {});
    return this.gateway.handleWebhook(raw, signature);
  }
}
