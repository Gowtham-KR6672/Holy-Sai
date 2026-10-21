import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, badRequest, fieldError, notFound, unavailable } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { SettingsService } from '../settings/settings.service';
import { inr, methodOf, num, r2 } from './finance.util';
import { FinanceLedgerService } from './ledger.service';
import { ForEachWorkspace } from '../../tenancy/for-each-workspace.decorator';

const API = 'https://api.razorpay.com/v1';
const NOT_SET_UP = 'Online payments are not set up yet. Connect Razorpay under Administration › Integrations (payment gateway) to accept Pay Now.';

export interface GatewayOrder {
  /** Our payment record (status Initiated until the gateway confirms). */
  paymentId: string;
  /** Razorpay order id, passed to Razorpay Checkout as order_id. */
  orderId: string;
  amount: number;
  amountPaise: number;
  currency: 'INR';
  /** Razorpay key id for Checkout (public). */
  keyId: string;
  name: string;
  description: string;
  prefill: { name: string | null; email: string | null; contact: string | null };
  notes: Record<string, string>;
}

export interface GatewayResult {
  id: string;
  receiptNo: string | null;
  amount: number;
  method: string;
  paidAt: string;
  gatewayRef: string | null;
  status: string;
}

/** Razorpay method → instrument shown on receipts. */
const INSTRUMENT: Record<string, string> = { upi: 'UPI', card: 'Card', netbanking: 'Net Banking', wallet: 'Wallet', emi: 'Card', cardless_emi: 'Card', paylater: 'Card' };

/**
 * Online fee payments through the 'payment' integration (Razorpay): create an order, verify the
 * Checkout signature, and accept the signed webhook. A confirmed payment settles charges and issues
 * the receipt through FinanceLedgerService. Exported for the parent portal ("Pay Now").
 */
@Injectable()
export class PaymentGatewayService {
  private readonly log = new Logger('PaymentGateway');

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly ledger: FinanceLedgerService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** True when Razorpay is enabled with a key id and secret. */
  async isConfigured(): Promise<boolean> {
    try {
      await this.config();
      return true;
    } catch {
      return false;
    }
  }

  private async config() {
    const i = await this.integrations.get('payment');
    if (!i.isEnabled || (i.provider && i.provider !== 'Razorpay') || !i.config.keyId || !i.secrets.keySecret) throw unavailable(NOT_SET_UP);
    return { keyId: i.config.keyId, keySecret: i.secrets.keySecret, webhookSecret: i.secrets.webhookSecret ?? null };
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown }, cfg: { keyId: string; keySecret: string }): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error?.description ?? `Razorpay returned ${res.status}`);
    return json as T;
  }

  /**
   * Starts an online payment for a student: validates the amount against the outstanding (or chosen) charges,
   * records an Initiated payment and creates the Razorpay order.
   */
  async createOrder(input: {
    studentId: string;
    amount?: number;
    feeIds?: string[];
    /** UPI | Card | Net Banking — what the payer picked (the gateway's actual method wins). */
    method?: string;
    paidBy?: { id?: string | null; name: string; email?: string | null; phone?: string | null } | null;
  }): Promise<GatewayOrder> {
    const cfg = await this.config();
    const info = (await this.ledger.studentInfo([input.studentId])).get(input.studentId);
    if (!info) throw notFound('Student');
    const open = await this.prisma.financeCharge.findMany({ where: { studentId: input.studentId, balance: { gt: 0 } }, select: { id: true, balance: true } });
    const feeIds = [...new Set(input.feeIds ?? [])];
    if (feeIds.some((id) => !open.find((c) => c.id === id))) throw fieldError('feeIds', 'One of the selected charges is already settled. Refresh and try again.');
    const cap = r2((feeIds.length ? open.filter((c) => feeIds.includes(c.id)) : open).reduce((s, c) => s + num(c.balance), 0));
    if (cap <= 0) throw badRequest('Nothing is outstanding on this account');
    const amount = r2(input.amount ?? cap);
    if (!(amount > 0)) throw fieldError('amount', 'Enter an amount greater than zero');
    if (amount > cap + 0.004) throw fieldError('amount', `Cannot exceed the outstanding balance of ${inr(cap)}.`);
    const instrument = input.method && ['UPI', 'Card', 'Net Banking'].includes(input.method) ? input.method : 'UPI';
    const y = await this.ledger.year();
    const payment = await this.prisma.financePayment.create({
      data: {
        studentId: input.studentId, campusId: info.campusId, academicYearId: y.id, amount, method: methodOf(instrument), instrument,
        status: 'Initiated', source: 'online', requestedFeeIds: feeIds, paidById: input.paidBy?.id ?? null, paidBy: input.paidBy?.name ?? null,
      },
    });
    const notes = { paymentId: payment.id, studentId: info.id, admissionNo: info.admissionNo };
    let order: { id: string };
    try {
      order = await this.call<{ id: string }>('/orders', { method: 'POST', body: { amount: Math.round(amount * 100), currency: 'INR', receipt: payment.id, notes } }, cfg);
    } catch (err) {
      await this.prisma.financePayment.update({ where: { id: payment.id }, data: { status: 'Failed', failureReason: (err as Error).message.slice(0, 300) } });
      throw unavailable(`The payment gateway could not start this payment: ${(err as Error).message}`);
    }
    await this.prisma.financePayment.update({ where: { id: payment.id }, data: { gatewayOrderId: order.id } });
    const school = await this.settings.get<string>('school.name', 'Holy Sai International School');
    return {
      paymentId: payment.id,
      orderId: order.id,
      amount,
      amountPaise: Math.round(amount * 100),
      currency: 'INR',
      keyId: cfg.keyId,
      name: school,
      description: `School fees — ${info.fullName} (${info.admissionNo})`,
      prefill: { name: input.paidBy?.name ?? null, email: input.paidBy?.email ?? null, contact: input.paidBy?.phone ?? null },
      notes,
    };
  }

  /** HMAC-SHA256 check of the Checkout response (order_id|payment_id signed with the key secret). */
  verifySignature(orderId: string, paymentId: string, signature: string, secret: string): boolean {
    return safeEqual(createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex'), signature);
  }

  /** Confirms a Checkout payment: verifies the signature, captures it if needed, settles charges and issues the receipt. */
  async verify(input: { orderId: string; paymentId: string; signature: string }): Promise<GatewayResult> {
    const cfg = await this.config();
    const row = await this.prisma.financePayment.findUnique({ where: { gatewayOrderId: input.orderId } });
    if (!row) throw notFound('Payment order');
    if (!this.verifySignature(input.orderId, input.paymentId, input.signature, cfg.keySecret)) {
      throw badRequest('The payment could not be verified. If money was debited, it will be confirmed automatically once the gateway reports it.');
    }
    let instrument: string | null = null;
    let amount: number | null = null;
    try {
      const gp = await this.call<{ status: string; method: string; amount: number; currency: string }>(`/payments/${input.paymentId}`, {}, cfg);
      instrument = INSTRUMENT[gp.method] ?? null;
      amount = gp.amount / 100;
      if (gp.status === 'authorized') await this.call(`/payments/${input.paymentId}/capture`, { method: 'POST', body: { amount: gp.amount, currency: gp.currency || 'INR' } }, cfg);
    } catch (err) {
      // The signature already proves the payment; details are refreshed by the webhook.
      this.log.warn(`Could not fetch Razorpay payment ${input.paymentId}: ${(err as Error).message}`);
    }
    const p = await this.ledger.settleOnlinePayment(row.id, { gatewayRef: input.paymentId, instrument, amount });
    await this.audit.record({
      userName: p.paidBy ?? 'Parent', action: 'create', module: 'finance', entityType: 'finance_payment', entityId: p.id, campusId: p.campusId,
      description: `Online payment ${p.receiptNo} of ${inr(num(p.amount))} confirmed (${input.paymentId})`,
    });
    return result(p);
  }

  /** Verifies and applies a Razorpay webhook (payment captured / failed, order paid, refunds). */
  async handleWebhook(rawBody: string, signature: string | undefined): Promise<{ received: true; event: string; handled: boolean }> {
    const i = await this.integrations.get('payment');
    const secret = i.secrets.webhookSecret;
    if (!secret) throw unavailable('The payment webhook secret is not configured. Add it under Administration › Integrations (payment gateway).');
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!signature || !safeEqual(expected, signature)) throw new AppError(401, 'UNAUTHORIZED', 'Invalid webhook signature');
    let evt: any;
    try {
      evt = JSON.parse(rawBody);
    } catch {
      throw badRequest('Invalid webhook payload');
    }
    const event = String(evt?.event ?? '');
    const pay = evt?.payload?.payment?.entity;
    let handled = false;
    if ((event === 'payment.captured' || event === 'order.paid') && pay?.order_id) {
      const row = await this.prisma.financePayment.findUnique({ where: { gatewayOrderId: pay.order_id } });
      if (row) {
        const p = await this.ledger.settleOnlinePayment(row.id, { gatewayRef: pay.id, instrument: INSTRUMENT[pay.method] ?? null, amount: typeof pay.amount === 'number' ? pay.amount / 100 : null });
        await this.audit.record({
          userName: 'Payment gateway', action: 'update', module: 'finance', entityType: 'finance_payment', entityId: p.id, campusId: p.campusId,
          description: `Razorpay ${event}: payment ${pay.id} confirmed as ${p.receiptNo}`,
        });
        handled = true;
      }
    } else if (event === 'payment.failed' && pay?.order_id) {
      const row = await this.prisma.financePayment.findUnique({ where: { gatewayOrderId: pay.order_id } });
      if (row && row.status === 'Initiated') {
        await this.prisma.financePayment.update({
          where: { id: row.id },
          data: { status: 'Failed', gatewayRef: pay.id ?? row.gatewayRef, failureReason: String(pay.error_description ?? 'Payment failed').slice(0, 300) },
        });
        handled = true;
      }
    } else if (event.startsWith('refund.') && event !== 'refund.failed') {
      const refund = evt?.payload?.refund?.entity;
      if (refund?.payment_id && event === 'refund.processed') {
        const row = await this.prisma.financePayment.findFirst({ where: { gatewayRef: refund.payment_id, status: 'Success' } });
        if (row) {
          const p = await this.ledger.refundPayment(row.id, Number(refund.amount ?? 0) / 100, `Refunded through Razorpay (${refund.id})`);
          await this.audit.record({
            userName: 'Payment gateway', action: 'update', module: 'finance', entityType: 'finance_payment', entityId: p.id, campusId: p.campusId,
            description: `Refund of ${inr(Number(refund.amount ?? 0) / 100)} processed on ${p.receiptNo}`,
          });
          handled = true;
        }
      }
    }
    return { received: true, event, handled };
  }

  /** Abandoned checkouts: online payments still Initiated after six hours are marked Failed. */
  @Cron('0 */30 * * * *')
  @ForEachWorkspace('finance-expire-checkouts')
  async expireAbandoned() {
    try {
      await this.prisma.financePayment.updateMany({
        where: { status: 'Initiated', source: 'online', createdAt: { lt: new Date(Date.now() - 6 * 3600_000) } },
        data: { status: 'Failed', failureReason: 'Checkout was not completed' },
      });
    } catch (err) {
      this.log.debug(`Expiry check skipped: ${(err as Error).message}`);
    }
  }

  /** Razorpay settlement entries for one day (used by reconciliation). Returns [] when payments are not configured. */
  async settlementEntries(date: string): Promise<{ id: string; paymentId: string; amount: number; settlementId: string | null; utr: string | null; settledAt: Date }[]> {
    let cfg: { keyId: string; keySecret: string };
    try {
      cfg = await this.config();
    } catch {
      return [];
    }
    const [y, m, d] = date.split('-');
    const out: { id: string; paymentId: string; amount: number; settlementId: string | null; utr: string | null; settledAt: Date }[] = [];
    for (let skip = 0; skip < 10_000; skip += 1000) {
      const page = await this.call<{ items: any[] }>(`/settlements/recon/combined?year=${y}&month=${Number(m)}&day=${Number(d)}&count=1000&skip=${skip}`, {}, cfg);
      for (const it of page.items ?? []) {
        if (it.type !== 'payment' || !it.entity_id) continue;
        out.push({
          id: `${it.entity_id}:${it.settlement_id ?? ''}`,
          paymentId: it.entity_id,
          amount: Number(it.amount ?? 0) / 100,
          settlementId: it.settlement_id ?? null,
          utr: it.settlement_utr ?? null,
          settledAt: it.settled_at ? new Date(Number(it.settled_at) * 1000) : new Date(`${date}T12:00:00+05:30`),
        });
      }
      if ((page.items ?? []).length < 1000) break;
    }
    return out;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function result(p: { id: string; receiptNo: string | null; amount: unknown; instrument: string; paidAt: Date; gatewayRef: string | null; status: string }): GatewayResult {
  return { id: p.id, receiptNo: p.receiptNo, amount: num(p.amount as number), method: p.instrument, paidAt: p.paidAt.toISOString(), gatewayRef: p.gatewayRef, status: p.status };
}
