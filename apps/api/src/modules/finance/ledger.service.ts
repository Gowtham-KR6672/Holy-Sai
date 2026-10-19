import { Injectable, Logger } from '@nestjs/common';
import type { FinancePayment, Prisma } from '@prisma/client';
import { badRequest, fieldError, notFound, unavailable } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { MessagingService } from '../integrations/messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import {
  accountStatus, addToAgg, COUNTER_METHODS, daysBetween, emptyAgg, firstName, inr, isoDate, istDate, lineStatus, methodOf, num, r2,
  roundAgg, today, type AccountAgg,
} from './finance.util';

type Tx = Prisma.TransactionClient;

export interface FinanceYear {
  id: string | null;
  label: string;
  start: Date;
  end: Date;
}

export interface StudentInfo {
  id: string;
  fullName: string;
  admissionNo: string;
  grade: string | null;
  gradeLevel: number;
  section: string | null;
  classId: string | null;
  sectionId: string;
  campusId: string;
  campus: string;
  campusName: string;
  status: string;
}

export interface RecordPaymentInput {
  studentId: string;
  amount: number;
  /** Cash | DD | Cheque | UPI | Card | Net Banking | Wallet … */
  instrument: string;
  /** UTR / DD / cheque number or gateway reference (e.g. "SIM-…" for the simulated gateway). */
  reference?: string | null;
  /** Charges to settle; when omitted the oldest dues are settled first. */
  feeIds?: string[];
  source: 'counter' | 'online';
  collectedBy?: { id: string; fullName: string } | null;
  paidBy?: { id?: string | null; name: string } | null;
}

export interface AccountView {
  student: {
    id: string; fullName: string; admissionNo: string; grade: string | null; section: string | null; campus: string; campusId: string;
    parentName: string | null; parentPhone: string | null; status: string;
  };
  summary: {
    billed: number; concession: number; paid: number; outstanding: number; overdue: number; nextDue: string | null; nextDueAmount: number;
    lateFee: number; lateFeePerDay: number;
  };
  lines: {
    id: string; description: string; head: string; feeHeadId: string; amountDue: number; concession: number; amountPaid: number; balance: number;
    dueDate: string; status: string; daysOverdue: number; lateFee: number;
  }[];
  payments: { id: string; receiptNo: string; amount: number; method: string; paidAt: string; status: string }[];
  concessions: { id: string; type: string; percent: number | null; amount: number; approvedBy: string | null; validUntil: string | null; status: string }[];
}

export interface ReceiptView {
  id: string;
  receiptNo: string;
  status: string;
  amount: number;
  method: string;
  methodGroup: string;
  gatewayRef: string | null;
  paidAt: string;
  paidBy: string | null;
  collectedBy: string | null;
  receiptSentAt: string | null;
  delivery: 'Delivered' | 'Pending';
  academicYear: string | null;
  student: { id: string; fullName: string; admissionNo: string; grade: string | null; section: string | null; campus: string; campusShort: string };
  lines: { feeId: string; description: string; head: string; amount: number; balanceAfter: number }[];
}

/**
 * The student ledger: academic-year scoping, account figures, charges, payments with receipts,
 * receipt delivery and concession credits. Exported for other modules (parents portal, students).
 */
@Injectable()
export class FinanceLedgerService {
  private readonly log = new Logger('Finance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly messaging: MessagingService,
    private readonly settings: SettingsService,
  ) {}

  // -------------------------------------------------------------------------
  // Academic year
  // -------------------------------------------------------------------------

  /** The current academic year; without one, the April–March year containing today. */
  async year(): Promise<FinanceYear> {
    const y = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    if (y) return { id: y.id, label: y.label, start: y.startsOn, end: y.endsOn };
    const t = today();
    const startYear = t.getUTCMonth() >= 3 ? t.getUTCFullYear() : t.getUTCFullYear() - 1;
    return {
      id: null,
      label: `${startYear}–${String((startYear + 1) % 100).padStart(2, '0')}`,
      start: new Date(Date.UTC(startYear, 3, 1)),
      end: new Date(Date.UTC(startYear + 1, 2, 31)),
    };
  }

  /** Charges belonging to the academic year. */
  yearWhere(y: FinanceYear): Prisma.FinanceChargeWhereInput {
    const inRange = { dueDate: { gte: y.start, lte: y.end } };
    return y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null, ...inRange }] } : inRange;
  }

  /** Charges on a student account: this year's, plus earlier ones still outstanding. */
  accountWhere(y: FinanceYear): Prisma.FinanceChargeWhereInput {
    return { OR: [this.yearWhere(y), { balance: { gt: 0 } }] };
  }

  /** Payments of the academic year. */
  paymentYearWhere(y: FinanceYear): Prisma.FinancePaymentWhereInput {
    return y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null, paidAt: { gte: y.start } }] } : { paidAt: { gte: y.start } };
  }

  // -------------------------------------------------------------------------
  // Students
  // -------------------------------------------------------------------------

  async studentInfo(ids: string[]): Promise<Map<string, StudentInfo>> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return new Map();
    const rows = await this.prisma.student.findMany({
      where: { id: { in: unique } },
      select: {
        id: true, fullName: true, admissionNo: true, status: true, campusId: true, sectionId: true,
        section: { select: { name: true, classId: true, class: { select: { name: true, gradeLevel: true } } } },
        campus: { select: { shortName: true, name: true } },
      },
    });
    return new Map(rows.map((s) => [s.id, {
      id: s.id,
      fullName: s.fullName,
      admissionNo: s.admissionNo,
      grade: s.section?.class?.name ?? null,
      gradeLevel: s.section?.class?.gradeLevel ?? 0,
      section: s.section?.name ?? null,
      classId: s.section?.classId ?? null,
      sectionId: s.sectionId,
      campusId: s.campusId,
      campus: s.campus?.shortName ?? '',
      campusName: s.campus?.name ?? '',
      status: s.status,
    }]));
  }

  /** Primary guardian (name and phone) of a student. */
  async primaryGuardian(studentId: string): Promise<{ name: string; phone: string | null } | null> {
    const links = await this.prisma.studentGuardian.findMany({ where: { studentId }, include: { guardian: true }, orderBy: { isPrimary: 'desc' } });
    const g = links.find((l) => l.isPrimary)?.guardian ?? links[0]?.guardian;
    if (!g) return null;
    const phone = g.phone?.trim() || links.map((l) => l.guardian.phone?.trim()).find(Boolean) || null;
    return { name: g.fullName, phone };
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  /** Billed, paid, balance, overdue, next due and status for each student (for lists in other modules). */
  async accountSummaries(studentIds: string[]): Promise<Map<string, { billed: number; paid: number; balance: number; overdue: number; nextDue: string | null; feeStatus: string }>> {
    const out = new Map<string, { billed: number; paid: number; balance: number; overdue: number; nextDue: string | null; feeStatus: string }>();
    if (!studentIds.length) return out;
    const y = await this.year();
    const t = today();
    const charges = await this.prisma.financeCharge.findMany({
      where: { studentId: { in: studentIds }, ...this.accountWhere(y) },
      select: { studentId: true, amount: true, concession: true, paid: true, balance: true, dueDate: true },
    });
    const aggs = new Map<string, AccountAgg>();
    for (const c of charges) {
      const a = aggs.get(c.studentId) ?? emptyAgg();
      addToAgg(a, { amount: num(c.amount), concession: num(c.concession), paid: num(c.paid), balance: num(c.balance), dueDate: c.dueDate }, t);
      aggs.set(c.studentId, a);
    }
    for (const id of studentIds) {
      const a = roundAgg(aggs.get(id) ?? emptyAgg());
      out.set(id, { billed: r2(a.billed - a.concession), paid: a.paid, balance: a.balance, overdue: a.overdue, nextDue: isoDate(a.nextDue), feeStatus: accountStatus(a) });
    }
    return out;
  }

  /** The full ledger of one student. */
  async account(studentId: string): Promise<AccountView> {
    const info = (await this.studentInfo([studentId])).get(studentId);
    if (!info) throw notFound('Student');
    const y = await this.year();
    const t = today();
    const [charges, payments, concessions, guardian, lateFeePerDay] = await Promise.all([
      this.prisma.financeCharge.findMany({
        where: { studentId, ...this.accountWhere(y) },
        include: { feeHead: { select: { name: true } } },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.financePayment.findMany({ where: { studentId, ...this.paymentYearWhere(y) }, orderBy: { paidAt: 'desc' } }),
      this.prisma.financeConcession.findMany({
        where: { studentId, ...(y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null, createdAt: { gte: y.start } }] } : { createdAt: { gte: y.start } }) },
        orderBy: { createdAt: 'desc' },
      }),
      this.primaryGuardian(studentId),
      this.settings.get<number>('finance.late_fee_per_day', 50),
    ]);
    const agg = emptyAgg();
    let lateFee = 0;
    const lines = charges.map((c) => {
      const f = { amount: num(c.amount), concession: num(c.concession), paid: num(c.paid), balance: num(c.balance), dueDate: c.dueDate };
      addToAgg(agg, f, t);
      const status = lineStatus(f, t);
      const daysOverdue = status === 'Overdue' ? daysBetween(c.dueDate, t) : 0;
      const lf = daysOverdue * (Number(lateFeePerDay) || 0);
      lateFee += lf;
      return {
        id: c.id, description: c.description, head: c.feeHead.name, feeHeadId: c.feeHeadId,
        amountDue: f.amount, concession: f.concession, amountPaid: f.paid, balance: f.balance,
        dueDate: isoDate(c.dueDate)!, status, daysOverdue, lateFee: lf,
      };
    });
    const a = roundAgg(agg);
    return {
      student: {
        id: info.id, fullName: info.fullName, admissionNo: info.admissionNo, grade: info.grade, section: info.section, campus: info.campus,
        campusId: info.campusId, parentName: guardian?.name ?? null, parentPhone: guardian?.phone ?? null, status: info.status,
      },
      summary: {
        billed: a.billed, concession: a.concession, paid: a.paid, outstanding: a.balance, overdue: a.overdue,
        nextDue: isoDate(a.nextDue), nextDueAmount: a.nextDueAmount, lateFee: r2(lateFee), lateFeePerDay: Number(lateFeePerDay) || 0,
      },
      lines,
      payments: payments.map((p) => ({
        id: p.id, receiptNo: p.receiptNo ?? p.gatewayOrderId ?? '—', amount: num(p.amount), method: p.method, paidAt: p.paidAt.toISOString(), status: p.status,
      })),
      concessions: concessions.map((c) => ({
        id: c.id, type: c.type, percent: c.percent == null ? null : num(c.percent), amount: num(c.amount),
        approvedBy: c.status === 'Approved' ? c.decidedBy : null, validUntil: isoDate(c.validUntil), status: c.status,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Charges and concession credit
  // -------------------------------------------------------------------------

  private async lockStudent(tx: Tx, studentId: string) {
    await tx.$queryRaw`SELECT id FROM "FinanceCharge" WHERE "studentId" = ${studentId}::uuid FOR UPDATE`;
  }

  /** Deducts what is left of an approved concession from the student's open charges, tuition first. Returns the amount applied now. */
  async applyConcession(tx: Tx, concessionId: string): Promise<number> {
    const c = await tx.financeConcession.findUnique({ where: { id: concessionId } });
    if (!c || c.status !== 'Approved') return 0;
    let left = r2(num(c.amount) - num(c.appliedAmount));
    if (left <= 0.004) return 0;
    await this.lockStudent(tx, c.studentId);
    const open = await tx.financeCharge.findMany({
      where: { studentId: c.studentId, balance: { gt: 0 } },
      include: { feeHead: { select: { name: true } } },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    });
    open.sort((a, b) => Number(b.feeHead.name === 'Tuition') - Number(a.feeHead.name === 'Tuition'));
    let applied = 0;
    for (const ch of open) {
      if (left <= 0.004) break;
      const x = r2(Math.min(num(ch.balance), left));
      if (x <= 0) continue;
      await tx.financeCharge.update({ where: { id: ch.id }, data: { concession: { increment: x }, balance: { decrement: x } } });
      left = r2(left - x);
      applied = r2(applied + x);
    }
    if (applied > 0) await tx.financeConcession.update({ where: { id: c.id }, data: { appliedAmount: { increment: applied } } });
    return applied;
  }

  /** Applies any unused approved concession value to newly raised charges. */
  async applyConcessionCredits(studentIds: string[]) {
    if (!studentIds.length) return;
    const rows = await this.prisma.financeConcession.findMany({
      where: { studentId: { in: [...new Set(studentIds)] }, status: 'Approved' },
      select: { id: true, amount: true, appliedAmount: true },
    });
    for (const c of rows) {
      if (num(c.amount) - num(c.appliedAmount) <= 0.004) continue;
      await this.prisma.$transaction((tx) => this.applyConcession(tx, c.id));
    }
  }

  /** Tuition billed (gross) to a student this academic year — the base for percentage concessions. */
  async tuitionBilled(studentId: string): Promise<number> {
    const y = await this.year();
    const r = await this.prisma.financeCharge.aggregate({
      where: { studentId, feeHead: { name: 'Tuition' }, ...this.yearWhere(y) },
      _sum: { amount: true },
    });
    return num(r._sum.amount);
  }

  // -------------------------------------------------------------------------
  // Payments
  // -------------------------------------------------------------------------

  private async nextReceiptNo(tx: Tx, at: Date): Promise<string> {
    const year = istDate(at).slice(0, 4);
    const key = `finance.receipt.${year}`;
    const row = await tx.counter.upsert({ where: { key }, create: { key, value: 1 }, update: { value: { increment: 1 } } });
    return `RCT-${year}-${String(row.value).padStart(6, '0')}`;
  }

  /** Settles open charges with a payment amount (chosen charges first). */
  private async allocate(tx: Tx, paymentId: string, studentId: string, amount: number, prefer: string[] = [], onlyPreferred = false) {
    await this.lockStudent(tx, studentId);
    const open = await tx.financeCharge.findMany({ where: { studentId, balance: { gt: 0 } }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }] });
    const preferred = open.filter((c) => prefer.includes(c.id));
    const order = onlyPreferred && prefer.length ? preferred : [...preferred, ...open.filter((c) => !prefer.includes(c.id))];
    let left = r2(amount);
    for (const c of order) {
      if (left <= 0.004) break;
      const bal = num(c.balance);
      const x = r2(Math.min(bal, left));
      if (x <= 0) continue;
      await tx.financeCharge.update({ where: { id: c.id }, data: { paid: { increment: x }, balance: { decrement: x } } });
      await tx.financePaymentAllocation.create({ data: { paymentId, chargeId: c.id, amount: x, balanceAfter: r2(bal - x) } });
      left = r2(left - x);
    }
    return left;
  }

  /** Validates and records a successful payment (counter collection, or an online payment confirmed elsewhere), issues the receipt and tells the parent. */
  async recordPayment(input: RecordPaymentInput): Promise<FinancePayment> {
    const instrument = COUNTER_METHODS.find((m) => m.toLowerCase() === input.instrument.trim().toLowerCase()) ?? (input.source === 'online' ? input.instrument.trim() : null);
    if (!instrument) throw fieldError('method', 'Choose a payment method');
    const amount = r2(Number(input.amount));
    if (!(amount > 0)) throw fieldError('amount', 'Enter an amount greater than zero');
    const reference = input.reference?.trim() || null;
    if (instrument !== 'Cash' && !reference) throw fieldError('reference', 'Enter the transaction, DD or cheque reference.');
    const info = (await this.studentInfo([input.studentId])).get(input.studentId);
    if (!info) throw notFound('Student');
    if (reference) {
      const dup = await this.prisma.financePayment.findFirst({ where: { gatewayRef: reference, status: 'Success', studentId: input.studentId } });
      if (dup) throw fieldError('reference', `This reference was already recorded on receipt ${dup.receiptNo}`);
    }
    const y = await this.year();
    const feeIds = [...new Set(input.feeIds ?? [])];

    const payment = await this.prisma.$transaction(async (tx) => {
      await this.lockStudent(tx, input.studentId);
      const open = await tx.financeCharge.findMany({ where: { studentId: input.studentId, balance: { gt: 0 } }, select: { id: true, balance: true } });
      const outstanding = r2(open.reduce((s, c) => s + num(c.balance), 0));
      if (feeIds.length && feeIds.some((id) => !open.find((c) => c.id === id))) throw fieldError('feeIds', 'One of the selected charges is already settled. Refresh and try again.');
      const cap = feeIds.length ? r2(open.filter((c) => feeIds.includes(c.id)).reduce((s, c) => s + num(c.balance), 0)) : outstanding;
      if (cap <= 0) throw badRequest('Nothing is outstanding on this account');
      if (amount > cap + 0.004) throw fieldError('amount', `Cannot exceed the ${feeIds.length ? 'selected' : 'outstanding'} balance of ${inr(cap)}.`);
      const paidAt = new Date();
      const p = await tx.financePayment.create({
        data: {
          studentId: input.studentId, campusId: info.campusId, academicYearId: y.id, amount, method: methodOf(instrument), instrument,
          status: 'Success', source: input.source, receiptNo: await this.nextReceiptNo(tx, paidAt), gatewayRef: reference,
          collectedById: input.collectedBy?.id ?? null, collectedBy: input.collectedBy?.fullName ?? null,
          paidById: input.paidBy?.id ?? null, paidBy: input.paidBy?.name ?? null, paidAt,
          reconciled: false,
        },
      });
      await this.allocate(tx, p.id, input.studentId, amount, feeIds, true);
      return p;
    });
    await this.afterPayment(payment);
    return payment;
  }

  /**
   * Marks an initiated online payment as paid (idempotent): settles charges (the payer's chosen lines first),
   * issues the receipt number, notifies the parent and sends the WhatsApp receipt.
   */
  async settleOnlinePayment(paymentId: string, conf: { gatewayRef: string; instrument?: string | null; amount?: number | null }): Promise<FinancePayment> {
    let fresh = false;
    const payment = await this.prisma.$transaction(async (tx) => {
      const p = await tx.financePayment.findUnique({ where: { id: paymentId } });
      if (!p) throw notFound('Payment');
      if (p.status === 'Success' || p.status === 'Refunded') return p;
      const amount = conf.amount != null ? r2(conf.amount) : num(p.amount);
      const instrument = conf.instrument?.trim() || p.instrument;
      const paidAt = new Date();
      const updated = await tx.financePayment.update({
        where: { id: p.id },
        data: {
          status: 'Success', amount, instrument, method: methodOf(instrument), gatewayRef: conf.gatewayRef, failureReason: null,
          receiptNo: p.receiptNo ?? (await this.nextReceiptNo(tx, paidAt)), paidAt,
        },
      });
      const prefer = Array.isArray(p.requestedFeeIds) ? (p.requestedFeeIds as string[]) : [];
      const left = await this.allocate(tx, p.id, p.studentId, amount, prefer, false);
      if (left > 0.004) this.log.warn(`Online payment ${updated.receiptNo} exceeds the outstanding balance by ${left}`);
      fresh = true;
      return updated;
    });
    if (fresh) await this.afterPayment(payment);
    return payment;
  }

  /** Reverses a refund: reopens the settled charges (latest due first) and marks the payment refunded when fully refunded. */
  async refundPayment(paymentId: string, refundAmount: number, note?: string): Promise<FinancePayment> {
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.financePayment.findUnique({ where: { id: paymentId }, include: { allocations: { include: { charge: true } } } });
      if (!p) throw notFound('Payment');
      if (p.status !== 'Success') return p;
      const already = num(p.refundedAmount);
      let left = r2(Math.min(refundAmount, num(p.amount) - already));
      if (left <= 0.004) return p;
      await this.lockStudent(tx, p.studentId);
      const allocs = [...p.allocations].sort((a, b) => b.charge.dueDate.getTime() - a.charge.dueDate.getTime());
      let reversed = 0;
      for (const a of allocs) {
        if (left <= 0.004) break;
        const x = r2(Math.min(num(a.amount), left));
        if (x <= 0) continue;
        await tx.financeCharge.update({ where: { id: a.chargeId }, data: { paid: { decrement: x }, balance: { increment: x } } });
        left = r2(left - x);
        reversed = r2(reversed + x);
      }
      const total = r2(already + reversed + left);
      const full = total >= num(p.amount) - 0.004;
      return tx.financePayment.update({
        where: { id: p.id },
        data: { refundedAmount: total, refundedAt: new Date(), ...(full ? { status: 'Refunded' } : {}), ...(note ? { failureReason: note } : {}) },
      });
    });
  }

  private async afterPayment(p: FinancePayment) {
    const info = (await this.studentInfo([p.studentId])).get(p.studentId);
    await this.notifications
      .notifyGuardians(p.studentId, {
        category: 'Completed',
        topic: 'fees',
        module: 'finance',
        title: `Fee payment received — ${p.receiptNo}`,
        body: `${inr(num(p.amount))} received${info ? ` for ${firstName(info.fullName)}` : ''} by ${p.instrument}. Thank you.`,
        route: '/parent-360?tab=fees',
        campusId: p.campusId,
      })
      .catch((e) => this.log.warn(`Payment notification failed: ${(e as Error).message}`));
    // Send the WhatsApp receipt, but do not hold the counter for a slow provider.
    const delivery = this.deliverReceipt(p.id).catch((e) => this.log.warn(`Receipt delivery failed: ${(e as Error).message}`));
    await Promise.race([delivery, new Promise((r) => setTimeout(r, 8000))]);
  }

  // -------------------------------------------------------------------------
  // Receipts
  // -------------------------------------------------------------------------

  async receipt(paymentId: string): Promise<ReceiptView> {
    const p = await this.prisma.financePayment.findUnique({
      where: { id: paymentId },
      include: { allocations: { include: { charge: { include: { feeHead: { select: { name: true } } } } } } },
    });
    if (!p) throw notFound('Payment');
    const [info, yearRow] = await Promise.all([
      this.studentInfo([p.studentId]).then((m) => m.get(p.studentId)),
      p.academicYearId ? this.prisma.academicYear.findUnique({ where: { id: p.academicYearId }, select: { label: true } }) : null,
    ]);
    const academicYear = yearRow?.label ?? (await this.year()).label;
    return {
      id: p.id,
      receiptNo: p.receiptNo ?? p.gatewayOrderId ?? '—',
      status: p.status,
      amount: num(p.amount),
      method: p.instrument,
      methodGroup: p.method,
      gatewayRef: p.gatewayRef,
      paidAt: p.paidAt.toISOString(),
      paidBy: p.paidBy,
      collectedBy: p.collectedBy,
      receiptSentAt: p.receiptSentAt?.toISOString() ?? null,
      delivery: p.receiptSentAt ? 'Delivered' : 'Pending',
      academicYear,
      student: {
        id: p.studentId,
        fullName: info?.fullName ?? 'Student',
        admissionNo: info?.admissionNo ?? '',
        grade: info?.grade ?? null,
        section: info?.section ?? null,
        campus: info?.campusName ?? '',
        campusShort: info?.campus ?? '',
      },
      lines: p.allocations.map((a) => ({
        feeId: a.chargeId, description: a.charge.description, head: a.charge.feeHead.name, amount: num(a.amount), balanceAfter: num(a.balanceAfter),
      })),
    };
  }

  /** Sends the receipt to the parent on WhatsApp and records when it went. */
  async deliverReceipt(paymentId: string, opts: { throwOnFailure?: boolean } = {}): Promise<{ ok: boolean; sentAt: Date | null; error?: string }> {
    const r = await this.receipt(paymentId);
    if (r.status !== 'Success') {
      if (opts.throwOnFailure) throw badRequest('Only successful payments have a receipt to send');
      return { ok: false, sentAt: null, error: 'Payment not successful' };
    }
    const guardian = await this.primaryGuardian(r.student.id);
    if (!guardian?.phone) {
      if (opts.throwOnFailure) throw badRequest('No parent mobile number is on file for this student');
      return { ok: false, sentAt: null, error: 'No parent mobile number' };
    }
    const lines = r.lines.map((l) => `• ${l.description}: ${inr(l.amount)}`).join('\n');
    const body = [
      `Holy Sai International — fee receipt ${r.receiptNo}`,
      `Student: ${r.student.fullName} (${r.student.admissionNo})`,
      `Amount: ${inr(r.amount)} by ${r.method} on ${istDate(new Date(r.paidAt))}`,
      r.gatewayRef ? `Reference: ${r.gatewayRef}` : null,
      lines || null,
      'Thank you.',
    ].filter(Boolean).join('\n');
    const res = await this.messaging.send('whatsapp', { to: guardian.phone, body }, { entityType: 'finance_payment', entityId: r.id });
    if (!res.ok) {
      if (opts.throwOnFailure) {
        throw unavailable(/not enabled/i.test(res.error ?? '')
          ? 'WhatsApp is not connected. Connect it under Administration › Integrations to send receipts.'
          : `The receipt could not be sent on WhatsApp: ${res.error ?? 'unknown error'}`);
      }
      return { ok: false, sentAt: null, error: res.error };
    }
    const sentAt = new Date();
    await this.prisma.financePayment.update({ where: { id: r.id }, data: { receiptSentAt: sentAt } });
    return { ok: true, sentAt };
  }

  // -------------------------------------------------------------------------
  // For dashboards in other modules
  // -------------------------------------------------------------------------

  /** Open finance approvals (expenses, concessions, reimbursements, allowances). */
  async pendingApprovals(campusId?: string) {
    const c = campusId ? { campusId } : {};
    const [expenses, concessions, reimbursements, allowances] = await Promise.all([
      this.prisma.financeExpense.count({ where: { ...c, status: { in: ['Submitted', 'Under Review'] } } }),
      this.prisma.financeConcession.count({ where: { ...c, status: { in: ['Submitted', 'Under Review'] } } }),
      this.prisma.financeReimbursement.count({ where: { ...c, status: { in: ['Submitted', 'Under Review'] } } }),
      this.prisma.financeAllowance.count({ where: { ...c, status: 'Submitted' } }),
    ]);
    return { expenses, concessions, reimbursements, allowances };
  }

  /** Headline fee figures for the command centre: billed (net), collected, outstanding, overdue, collected today. */
  async feeSnapshot(campusId?: string) {
    const y = await this.year();
    const t = today();
    const charges = await this.prisma.financeCharge.findMany({
      where: { ...(campusId ? { campusId } : {}), ...this.accountWhere(y) },
      select: { studentId: true, amount: true, concession: true, paid: true, balance: true, dueDate: true },
    });
    let billed = 0;
    let collected = 0;
    let outstanding = 0;
    let overdue = 0;
    const overdueStudents = new Set<string>();
    for (const c of charges) {
      billed += num(c.amount) - num(c.concession);
      collected += num(c.paid);
      outstanding += num(c.balance);
      if (num(c.balance) > 0 && c.dueDate < t) {
        overdue += num(c.balance);
        overdueStudents.add(c.studentId);
      }
    }
    const todayPaid = await this.prisma.financePayment.aggregate({
      where: { ...(campusId ? { campusId } : {}), status: 'Success', paidAt: { gte: new Date(`${istDate(new Date())}T00:00:00+05:30`) } },
      _sum: { amount: true },
    });
    return {
      billed: r2(billed), collected: r2(collected), outstanding: r2(outstanding), overdue: r2(overdue), overdueAccounts: overdueStudents.size,
      collectedToday: num(todayPaid._sum.amount), collectionPct: billed ? Math.round((collected / billed) * 1000) / 10 : 0,
    };
  }
}
