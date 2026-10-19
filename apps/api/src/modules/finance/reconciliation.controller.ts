import { Body, Controller, Get, HttpCode, Logger, Param, Post, Query, Req } from '@nestjs/common';
import type { FinancePayment, FinanceReconLine, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { addDays, dateOnly, inr, isoDate, istDate, num, r2, RECON_STATUSES, today, uuidOr404 } from './finance.util';
import { FinanceLedgerService } from './ledger.service';
import { PaymentGatewayService } from './payment-gateway.service';

class LineQuery extends ListQuery {
  @IsOptional() @IsIn(RECON_STATUSES) status?: string;
}

class NoteDto {
  @IsString() @MinLength(3, { message: 'Please give a reason (at least 3 characters).' }) @MaxLength(500) note: string;
}

class MatchDto {
  @IsUUID('all', { message: 'Choose a receipt.' }) paymentId: string;
}

class ImportLineDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use YYYY-MM-DD dates.' }) statementDate: string;
  @IsOptional() @IsString() @MaxLength(60) channel?: string;
  @IsString() @MinLength(2) @MaxLength(120) reference: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive() amount: number;
}

class ImportDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => ImportLineDto) lines: ImportLineDto[];
}

/** Gateway settlements and bank statement lines matched to receipts by reference. */
@Controller('finance/reconciliation')
@RequirePermissions('finance.read')
export class FinanceReconciliationController {
  private readonly log = new Logger('Reconciliation');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: FinanceLedgerService,
    private readonly gateway: PaymentGatewayService,
  ) {}

  private async rows(list: (FinanceReconLine & { payment: FinancePayment | null })[]) {
    const info = await this.ledger.studentInfo(list.map((l) => l.payment?.studentId).filter((x): x is string => !!x));
    return list.map((l) => ({
      id: l.id,
      statementDate: isoDate(l.statementDate)!,
      reference: l.reference,
      channel: l.channel,
      amount: num(l.amount),
      status: l.status,
      note: l.note,
      paymentId: l.paymentId,
      receiptNo: l.payment?.receiptNo ?? null,
      studentName: l.payment ? info.get(l.payment.studentId)?.fullName ?? null : null,
      settlementId: l.settlementId,
      matchedBy: l.matchedBy,
      matchedAt: l.matchedAt?.toISOString() ?? null,
      resolvedBy: l.resolvedBy,
      resolvedAt: l.resolvedAt?.toISOString() ?? null,
    }));
  }

  @Get('summary')
  async summary() {
    const latest = await this.prisma.financeReconLine.findFirst({ orderBy: { statementDate: 'desc' }, select: { statementDate: true } });
    const [matchedLatest, settlement, exceptions, unmatched, inTransit] = await Promise.all([
      latest ? this.prisma.financeReconLine.count({ where: { statementDate: latest.statementDate, status: 'Matched' } }) : 0,
      latest ? this.prisma.financeReconLine.aggregate({ where: { statementDate: latest.statementDate }, _sum: { amount: true } }) : null,
      this.prisma.financeReconLine.count({ where: { status: 'Exception' } }),
      this.prisma.financeReconLine.count({ where: { status: 'Unmatched' } }),
      this.prisma.financePayment.aggregate({ where: { status: 'Success', reconciled: false, source: 'online' }, _sum: { amount: true } }),
    ]);
    return {
      latestDate: isoDate(latest?.statementDate),
      matchedLatest,
      settlementLatest: num(settlement?._sum.amount),
      exceptions,
      unmatched,
      inTransit: num(inTransit._sum.amount),
    };
  }

  @Get('lines')
  async lines(@Query() q: LineQuery) {
    const p = pageOf(q);
    const term = q.q?.trim();
    const where: Prisma.FinanceReconLineWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(term ? { OR: [{ reference: like(term) }, { note: like(term) }, { channel: like(term) }, { payment: { receiptNo: like(term) } }] } : {}),
    };
    const dir = q.dir ?? 'desc';
    const orderBy: Prisma.FinanceReconLineOrderByWithRelationInput[] =
      q.sort === 'reference' ? [{ reference: dir }]
        : q.sort === 'amount' ? [{ amount: dir }]
          : q.sort === 'status' ? [{ status: dir }, { statementDate: 'desc' }]
            : [{ statementDate: dir }, { createdAt: dir }];
    const [rows, total] = await Promise.all([
      this.prisma.financeReconLine.findMany({ where, include: { payment: true }, orderBy, skip: p.skip, take: p.take }),
      this.prisma.financeReconLine.count({ where }),
    ]);
    return paged(await this.rows(rows), total, p);
  }

  @Get('lines/:id/candidates')
  async candidates(@Param('id') id: string) {
    const line = await this.prisma.financeReconLine.findUnique({ where: { id: uuidOr404(id, 'Statement line') } });
    if (!line) throw notFound('Statement line');
    const amount = num(line.amount);
    const from = addDays(line.statementDate, -15);
    const to = addDays(line.statementDate, 2);
    const list = await this.prisma.financePayment.findMany({
      where: {
        status: 'Success',
        reconciled: false,
        OR: [
          { gatewayRef: line.reference },
          { receiptNo: line.reference },
          { amount: { gte: r2(amount * 0.95), lte: r2(amount * 1.05) }, paidAt: { gte: from, lt: to } },
        ],
      },
      orderBy: { paidAt: 'desc' },
      take: 25,
    });
    const info = await this.ledger.studentInfo(list.map((p) => p.studentId));
    return list
      .map((p) => ({
        id: p.id,
        receiptNo: p.receiptNo ?? '—',
        gatewayRef: p.gatewayRef,
        method: p.method,
        studentId: p.studentId,
        studentName: info.get(p.studentId)?.fullName ?? 'Student',
        admissionNo: info.get(p.studentId)?.admissionNo ?? '',
        amount: num(p.amount),
        amountDiff: r2(Math.abs(num(p.amount) - amount)),
        paidAt: p.paidAt.toISOString(),
        referenceMatch: p.gatewayRef === line.reference || p.receiptNo === line.reference,
      }))
      .sort((a, b) => Number(b.referenceMatch) - Number(a.referenceMatch) || a.amountDiff - b.amountDiff);
  }

  @Post('run')
  @HttpCode(200)
  @RequirePermissions('finance.manage')
  async run(@CurrentUser() user: AuthUser, @Req() req: Request) {
    const imported = await this.importFromGateway();
    const open = await this.prisma.financeReconLine.findMany({ where: { status: 'Unmatched' }, orderBy: { statementDate: 'asc' } });
    let matched = 0;
    let exceptions = 0;
    for (const line of open) {
      const amount = num(line.amount);
      const pay = await this.prisma.financePayment.findFirst({ where: { status: 'Success', OR: [{ gatewayRef: line.reference }, { receiptNo: line.reference }] } });
      if (!pay) {
        await this.prisma.financeReconLine.update({ where: { id: line.id }, data: { status: 'Exception', note: 'No receipt carries this reference' } });
        exceptions++;
        continue;
      }
      if (pay.reconciled) {
        const other = await this.prisma.financeReconLine.findFirst({ where: { paymentId: pay.id, status: 'Matched', id: { not: line.id } } });
        if (other) {
          await this.prisma.financeReconLine.update({ where: { id: line.id }, data: { status: 'Exception', note: `Duplicate settlement — ${pay.receiptNo} is already matched to another line`, paymentId: pay.id } });
          exceptions++;
          continue;
        }
      }
      const diff = r2(num(pay.amount) - amount);
      if (Math.abs(diff) > 0.009) {
        await this.prisma.financeReconLine.update({
          where: { id: line.id },
          data: { status: 'Exception', paymentId: pay.id, note: `Amount differs from ${pay.receiptNo} (${inr(num(pay.amount))}) by ${inr(Math.abs(diff))}` },
        });
        exceptions++;
        continue;
      }
      await this.prisma.$transaction([
        this.prisma.financeReconLine.update({ where: { id: line.id }, data: { status: 'Matched', paymentId: pay.id, matchedAt: new Date(), matchedBy: 'Automatic', note: null } }),
        this.prisma.financePayment.update({ where: { id: pay.id }, data: { reconciled: true, reconciledAt: new Date() } }),
      ]);
      matched++;
    }
    await this.audit.record({
      user, action: 'update', module: 'finance', entityType: 'finance_reconciliation', req,
      description: `Ran reconciliation: ${matched} matched, ${exceptions} exception(s)${imported ? `, ${imported} settlement line(s) imported` : ''}`,
    });
    const parts = [`${matched} matched`, `${exceptions} exception${exceptions === 1 ? '' : 's'}`];
    if (imported) parts.push(`${imported} line${imported === 1 ? '' : 's'} imported from Razorpay`);
    return ok({ matched, exceptions, imported }, open.length || imported ? `Reconciliation complete — ${parts.join(', ')}` : 'Nothing new to reconcile');
  }

  /** Pulls the last seven days of Razorpay settlement entries as statement lines (once each). */
  private async importFromGateway(): Promise<number> {
    if (!(await this.gateway.isConfigured())) return 0;
    let n = 0;
    const t = today();
    for (let i = 1; i <= 7; i++) {
      const day = isoDate(addDays(t, -i))!;
      let entries: Awaited<ReturnType<PaymentGatewayService['settlementEntries']>> = [];
      try {
        entries = await this.gateway.settlementEntries(day);
      } catch (err) {
        this.log.warn(`Razorpay settlements for ${day}: ${(err as Error).message}`);
        continue;
      }
      for (const e of entries) {
        const exists = await this.prisma.financeReconLine.findUnique({ where: { externalId: e.id } });
        if (exists) continue;
        await this.prisma.financeReconLine.create({
          data: {
            statementDate: dateOnly(istDate(e.settledAt)), channel: 'Razorpay', reference: e.paymentId, amount: r2(e.amount), status: 'Unmatched',
            source: 'gateway', externalId: e.id, settlementId: e.settlementId, note: e.utr ? `Settlement UTR ${e.utr}` : null,
          },
        });
        n++;
      }
    }
    return n;
  }

  @Post('import')
  @HttpCode(200)
  @RequirePermissions('finance.manage')
  async import(@Body() dto: ImportDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.prisma.financeReconLine.createMany({
      data: dto.lines.map((l) => ({
        statementDate: dateOnly(l.statementDate), channel: l.channel?.trim() || 'Bank', reference: l.reference.trim(), amount: r2(l.amount),
        status: 'Unmatched', source: 'import', createdById: user.id,
      })),
    });
    await this.audit.record({ user, action: 'create', module: 'finance', entityType: 'finance_reconciliation', req, description: `Imported ${r.count} statement line(s)` });
    return ok({ imported: r.count }, `${r.count} statement line(s) imported — run reconciliation to match them`);
  }

  private async load(id: string) {
    const line = await this.prisma.financeReconLine.findUnique({ where: { id: uuidOr404(id, 'Statement line') } });
    if (!line) throw notFound('Statement line');
    return line;
  }

  @Post('lines/:id/match')
  @HttpCode(200)
  @RequirePermissions('finance.manage')
  async match(@Param('id') id: string, @Body() dto: MatchDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const line = await this.load(id);
    if (!['Unmatched', 'Exception'].includes(line.status)) throw badRequest('This line is already matched or resolved');
    const pay = await this.prisma.financePayment.findUnique({ where: { id: dto.paymentId } });
    if (!pay || pay.status !== 'Success') throw badRequest('Choose a successful payment to match');
    if (pay.reconciled) throw badRequest(`${pay.receiptNo} is already reconciled`);
    const diff = r2(Math.abs(num(pay.amount) - num(line.amount)));
    const note = diff > 0.009 ? `Matched manually to ${pay.receiptNo}; amounts differ by ${inr(diff)}` : `Matched manually to ${pay.receiptNo}`;
    await this.prisma.$transaction([
      this.prisma.financeReconLine.update({ where: { id: line.id }, data: { status: 'Matched', paymentId: pay.id, matchedAt: new Date(), matchedBy: user.fullName, note } }),
      this.prisma.financePayment.update({ where: { id: pay.id }, data: { reconciled: true, reconciledAt: new Date() } }),
    ]);
    await this.audit.record({
      user, action: 'update', module: 'finance', entityType: 'finance_reconciliation', entityId: line.id, campusId: pay.campusId, req,
      description: `Matched statement line ${line.reference} (${inr(num(line.amount))}) to ${pay.receiptNo}${diff > 0.009 ? ` — difference ${inr(diff)}` : ''}`,
    });
    return ok({ id: line.id, status: 'Matched' }, `${line.reference} matched to ${pay.receiptNo}`);
  }

  @Post('lines/:id/resolve')
  @HttpCode(200)
  @RequirePermissions('finance.manage')
  async resolve(@Param('id') id: string, @Body() dto: NoteDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const line = await this.load(id);
    if (line.status !== 'Exception' && line.status !== 'Unmatched') throw badRequest('Only exceptions can be resolved');
    await this.prisma.financeReconLine.update({ where: { id: line.id }, data: { status: 'Resolved', note: dto.note.trim(), resolvedAt: new Date(), resolvedBy: user.fullName } });
    await this.audit.record({ user, action: 'update', module: 'finance', entityType: 'finance_reconciliation', entityId: line.id, req, description: `Resolved statement line ${line.reference}: ${dto.note.trim()}` });
    return ok({ id: line.id, status: 'Resolved' }, `${line.reference} marked resolved`);
  }

  @Post('lines/:id/exception')
  @HttpCode(200)
  @RequirePermissions('finance.manage')
  async flag(@Param('id') id: string, @Body() dto: NoteDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const line = await this.load(id);
    if (!['Unmatched', 'Matched'].includes(line.status)) throw badRequest('Only unmatched or matched lines can be flagged');
    await this.prisma.$transaction([
      this.prisma.financeReconLine.update({ where: { id: line.id }, data: { status: 'Exception', note: dto.note.trim(), ...(line.status === 'Matched' ? { matchedAt: null, matchedBy: null } : {}) } }),
      ...(line.status === 'Matched' && line.paymentId
        ? [this.prisma.financePayment.update({ where: { id: line.paymentId }, data: { reconciled: false, reconciledAt: null } })]
        : []),
    ]);
    await this.audit.record({ user, action: 'update', module: 'finance', entityType: 'finance_reconciliation', entityId: line.id, req, description: `Flagged statement line ${line.reference} as an exception: ${dto.note.trim()}` });
    return ok({ id: line.id, status: 'Exception' }, `${line.reference} flagged as an exception`);
  }
}
