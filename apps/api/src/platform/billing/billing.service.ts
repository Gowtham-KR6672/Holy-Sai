import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma as PlatformPrismaNs } from '.prisma/platform-client';
import type { Request } from 'express';
import { env } from '../../config/env';
import { AppError, badRequest, fieldError, notFound, unavailable } from '../../common/errors';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { PlatformDb } from '../../tenancy/platform-db.service';
import { PlatformSettings } from '../../tenancy/platform-settings.service';
import { addDays, dateKey, periodEnd, SubscriptionStatusService, todayIn } from '../../tenancy/subscription-status.service';
import { TenancyService } from '../../tenancy/tenancy.service';
import { PlatformAudit } from '../platform-audit.service';
import type { PlatformAdminUser } from '../platform.guard';
import { SUPPORT_EMAIL_DOMAIN } from '../provisioning.service';
import { GATEWAYS, GatewayConfigs, type GatewayKey, paypal, razorpay, razorpayCheckoutValid, stripe } from './gateways';
import { renderInvoicePdf } from './invoice-pdf';
import { PlatformMailer } from './platform-mailer.service';

/** The four plans; prices are set by a platform admin (0 = not offered online yet). */
export const DEFAULT_PLANS = [
  { code: 'monthly', name: 'Monthly', months: 1, sortOrder: 1 },
  { code: 'quarterly', name: 'Quarterly', months: 3, sortOrder: 2 },
  { code: 'half_yearly', name: 'Half-yearly', months: 6, sortOrder: 3 },
  { code: 'annual', name: 'Annual', months: 12, sortOrder: 4 },
];

const num = (d: PlatformPrismaNs.Decimal | number | string | null | undefined) => (d == null ? 0 : Number(d));
const round2 = (n: number) => Math.round(n * 100) / 100;
const toMinor = (amount: number) => Math.round(amount * 100);
const dbDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
const STALE_CHECKOUT_MS = 6 * 3600_000;

export interface CheckoutStart {
  paymentId: string;
  gateway: GatewayKey;
  amount: number;
  currency: string;
  /** Razorpay: open Checkout.js with this order. */
  razorpay?: { keyId: string; orderId: string; amount: number; currency: string; name: string; description: string; prefill: { name?: string; email?: string } };
  /** Stripe / PayPal: send the browser here. */
  redirectUrl?: string;
}

/**
 * Subscriptions and their money: plans, periods, manual and online payments, invoices and receipts. A payment is
 * settled once (gateways retry webhooks and the browser may confirm too): it becomes paid, adds a period starting
 * after the current end date (or today, if that has passed) and gets an invoice.
 */
@Injectable()
export class BillingService implements OnModuleInit {
  private readonly log = new Logger('Billing');

  constructor(
    private readonly platform: PlatformDb,
    private readonly tenancy: TenancyService,
    private readonly status: SubscriptionStatusService,
    private readonly settings: PlatformSettings,
    private readonly gateways: GatewayConfigs,
    private readonly mailer: PlatformMailer,
    private readonly notifications: NotificationsService,
    private readonly audit: PlatformAudit,
  ) {}

  async onModuleInit() {
    try {
      for (const p of DEFAULT_PLANS) {
        await this.platform.plan.upsert({ where: { code: p.code }, create: p, update: {} });
      }
    } catch (err) {
      this.log.warn(`Plans not seeded: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------------------------------------------

  async plans() {
    const rows = await this.platform.plan.findMany({ orderBy: { sortOrder: 'asc' } });
    return rows.map((p) => ({ code: p.code, name: p.name, months: p.months, priceInr: num(p.priceInr), priceUsd: num(p.priceUsd), isActive: p.isActive }));
  }

  async updatePlan(code: string, body: { priceInr?: number; priceUsd?: number; isActive?: boolean; name?: string }, admin: PlatformAdminUser, req?: Request) {
    const plan = await this.platform.plan.findUnique({ where: { code } });
    if (!plan) throw notFound('Plan');
    for (const k of ['priceInr', 'priceUsd'] as const) {
      if (body[k] !== undefined && (!Number.isFinite(body[k]) || body[k]! < 0)) throw fieldError(k, 'Enter a price of 0 or more');
    }
    await this.platform.plan.update({
      where: { code },
      data: { priceInr: body.priceInr, priceUsd: body.priceUsd, isActive: body.isActive, name: body.name?.trim() || undefined },
    });
    await this.audit.record({ admin, action: 'update', entityType: 'plan', entityId: code, description: `Updated the ${plan.name} plan`, metadata: body as Record<string, unknown>, req });
  }

  private async plan(code: string) {
    const p = await this.platform.plan.findUnique({ where: { code } });
    if (!p) throw fieldError('planCode', 'Choose a plan');
    return p;
  }

  /** What a plan costs a school (its billing currency), with tax from Platform settings. */
  async priceFor(planCode: string, currency: string) {
    const p = await this.plan(planCode);
    const subtotal = num(currency === 'USD' ? p.priceUsd : p.priceInr);
    const taxPercent = Number(await this.settings.get<number>(currency === 'USD' ? 'billing.tax_percent_usd' : 'billing.tax_percent_inr')) || 0;
    const taxAmount = round2((subtotal * taxPercent) / 100);
    return { plan: p, subtotal, taxPercent, taxAmount, total: round2(subtotal + taxAmount) };
  }

  // -------------------------------------------------------------------------------------------------------------
  // A school's subscription
  // -------------------------------------------------------------------------------------------------------------

  async summary(workspaceId: string) {
    const ws = await this.platform.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw notFound('School');
    const [status, periods, payments, invoices, plans, gateways] = await Promise.all([
      this.status.forWorkspace(workspaceId),
      this.platform.subscriptionPeriod.findMany({ where: { workspaceId }, orderBy: { startsOn: 'desc' }, take: 50 }),
      this.platform.payment.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.platform.invoice.findMany({ where: { workspaceId }, orderBy: { issuedAt: 'desc' }, take: 50 }),
      this.plans(),
      this.gateways.availableFor(ws.currency),
    ]);
    const taxPercent = Number(await this.settings.get<number>(ws.currency === 'USD' ? 'billing.tax_percent_usd' : 'billing.tax_percent_inr')) || 0;
    return {
      currency: ws.currency,
      status,
      plans: plans.filter((p) => p.isActive).map((p) => {
        const price = ws.currency === 'USD' ? p.priceUsd : p.priceInr;
        return { code: p.code, name: p.name, months: p.months, price, total: round2(price * (1 + taxPercent / 100)), taxPercent, available: price > 0 };
      }),
      gateways: gateways.map((g) => ({ gateway: g, label: GATEWAYS[g].label })),
      periods: periods.map((p) => ({ id: p.id, planCode: p.planCode, startsOn: dateKey(p.startsOn), endsOn: dateKey(p.endsOn), source: p.source, note: p.note, createdAt: p.createdAt.toISOString() })),
      payments: payments.map((p) => ({
        id: p.id, planCode: p.planCode, amount: num(p.amount), currency: p.currency, gateway: p.gateway, method: p.method, status: p.status,
        reference: p.reference ?? p.gatewayPaymentId, paidAt: p.paidAt?.toISOString() ?? null, createdAt: p.createdAt.toISOString(), invoiceId: p.invoiceId, failureReason: p.failureReason,
      })),
      invoices: invoices.map((i) => ({ id: i.id, number: i.number, total: num(i.total), currency: i.currency, issuedAt: i.issuedAt.toISOString(), periodStart: dateKey(i.periodStart), periodEnd: dateKey(i.periodEnd) })),
    };
  }

  /** The first day of the next period: the day after the current end date, or today if that has passed. */
  private async nextStart(workspaceId: string, timezone: string) {
    const latest = await this.platform.subscriptionPeriod.findFirst({ where: { workspaceId }, orderBy: { endsOn: 'desc' } });
    const today = todayIn(timezone);
    if (!latest) return today;
    const after = addDays(dateKey(latest.endsOn), 1);
    return after > today ? after : today;
  }

  /** Starts a school's subscription: a trial of N days, or a plan period from a date (usually with a payment). */
  async start(workspaceId: string, body: { planCode: string; startsOn?: string; trialDays?: number; note?: string }, admin: PlatformAdminUser | null, req?: Request) {
    const ws = await this.platform.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw notFound('School');
    const plan = await this.plan(body.planCode);
    const startsOn = body.startsOn && /^\d{4}-\d{2}-\d{2}$/.test(body.startsOn) ? body.startsOn : todayIn(ws.timezone);
    const trial = body.trialDays !== undefined && body.trialDays !== null;
    if (trial && (!Number.isInteger(body.trialDays) || body.trialDays! < 1 || body.trialDays! > 366)) throw fieldError('trialDays', 'Trial days: 1 to 366');
    const endsOn = trial ? addDays(startsOn, body.trialDays! - 1) : periodEnd(startsOn, plan.months);
    const period = await this.platform.subscriptionPeriod.create({
      data: { workspaceId, planCode: plan.code, startsOn: dbDate(startsOn), endsOn: dbDate(endsOn), source: trial ? 'trial' : 'manual', note: body.note?.trim() || null, createdById: admin?.id ?? null },
    });
    this.status.invalidate(workspaceId);
    await this.audit.record({
      admin, action: 'subscription', entityType: 'workspace', entityId: workspaceId, workspaceId,
      description: `${trial ? `Started a ${body.trialDays}-day trial` : `Started the ${plan.name} plan`} for ${ws.name}: ${startsOn} to ${endsOn}`, req,
    });
    return period;
  }

  /** Moves the end date later (a goodwill extension or an agreed delay), with a reason. */
  async extendTo(workspaceId: string, endsOn: string, reason: string, admin: PlatformAdminUser, req?: Request) {
    const ws = await this.platform.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw notFound('School');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) throw fieldError('endsOn', 'Choose a date');
    if (!reason?.trim()) throw fieldError('reason', 'Give a reason');
    const latest = await this.platform.subscriptionPeriod.findFirst({ where: { workspaceId }, orderBy: { endsOn: 'desc' } });
    const startsOn = await this.nextStart(workspaceId, ws.timezone);
    if (endsOn < startsOn) throw fieldError('endsOn', `Choose a date on or after ${startsOn}`);
    await this.platform.subscriptionPeriod.create({
      data: { workspaceId, planCode: latest?.planCode ?? 'monthly', startsOn: dbDate(startsOn), endsOn: dbDate(endsOn), source: 'adjustment', note: reason.trim(), createdById: admin.id },
    });
    this.status.invalidate(workspaceId);
    await this.audit.record({ admin, action: 'subscription', entityType: 'workspace', entityId: workspaceId, workspaceId, description: `Extended ${ws.name} to ${endsOn}: ${reason.trim()}`, req });
  }

  /** A payment received outside We School (bank transfer, UPI, cheque, cash): extends the subscription. */
  async recordManual(
    workspaceId: string,
    body: { planCode: string; amount: number; method: string; reference?: string; paidOn?: string; note?: string },
    admin: PlatformAdminUser,
    req?: Request,
  ) {
    const ws = await this.platform.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw notFound('School');
    await this.plan(body.planCode);
    if (!Number.isFinite(body.amount) || body.amount <= 0) throw fieldError('amount', 'Enter the amount received');
    const paidAt = body.paidOn && /^\d{4}-\d{2}-\d{2}$/.test(body.paidOn) ? new Date(`${body.paidOn}T12:00:00.000Z`) : new Date();
    const payment = await this.platform.payment.create({
      data: {
        workspaceId, planCode: body.planCode, amount: round2(body.amount), currency: ws.currency, gateway: 'manual', method: body.method?.trim() || 'bank',
        reference: body.reference?.trim() || null, status: 'initiated', recordedById: admin.id,
      },
    });
    const result = await this.settle(payment.id, { paidAt, method: payment.method, note: body.note });
    await this.audit.record({
      admin, action: 'payment', entityType: 'payment', entityId: payment.id, workspaceId,
      description: `Recorded ${ws.currency} ${round2(body.amount)} (${payment.method}${payment.reference ? ` ${payment.reference}` : ''}) for ${ws.name}`, req,
    });
    return result;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Online payments (the school's Workspace Admin renews)
  // -------------------------------------------------------------------------------------------------------------

  async checkout(workspaceId: string, planCode: string, gateway: GatewayKey, payer: { userId: string; name: string; email: string }): Promise<CheckoutStart> {
    const ws = await this.platform.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw notFound('School');
    const def = GATEWAYS[gateway];
    if (!def) throw fieldError('gateway', 'Choose how to pay');
    if (def.currency !== ws.currency) throw fieldError('gateway', `${def.label} does not take ${ws.currency} payments`);
    const creds = await this.gateways.get(gateway);
    if (!creds.isEnabled) throw unavailable(`${def.label} is not available right now. Please contact We School.`);
    const price = await this.priceFor(planCode, ws.currency);
    if (price.total <= 0) throw badRequest(`The ${price.plan.name} plan cannot be paid online yet. Please contact We School.`);
    const description = `We School ${price.plan.name} plan — ${ws.name}`;
    const payment = await this.platform.payment.create({
      data: { workspaceId, planCode, amount: price.total, currency: ws.currency, gateway, status: 'initiated', initiatedById: payer.userId },
    });
    const web = env().publicWebUrl;
    try {
      if (gateway === 'razorpay' || gateway === 'razorpay_intl') {
        const order = await razorpay<{ id: string }>(creds, 'POST', '/orders', {
          amount: toMinor(price.total), currency: ws.currency, receipt: payment.id.slice(0, 40), notes: { workspaceId, workspace: ws.code, plan: planCode, paymentId: payment.id },
        });
        await this.platform.payment.update({ where: { id: payment.id }, data: { gatewayOrderId: order.id } });
        return {
          paymentId: payment.id, gateway, amount: price.total, currency: ws.currency,
          razorpay: { keyId: creds.config.keyId, orderId: order.id, amount: toMinor(price.total), currency: ws.currency, name: 'We School', description, prefill: { name: payer.name, email: payer.email } },
        };
      }
      if (gateway === 'stripe') {
        const session = await stripe<{ id: string; url: string }>(creds, 'POST', '/checkout/sessions', {
          mode: 'payment',
          success_url: `${web}/admin/subscription?gateway=stripe&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${web}/admin/subscription?cancelled=1`,
          client_reference_id: payment.id,
          'metadata[paymentId]': payment.id,
          'metadata[workspace]': ws.code,
          'line_items[0][quantity]': 1,
          'line_items[0][price_data][currency]': ws.currency.toLowerCase(),
          'line_items[0][price_data][unit_amount]': toMinor(price.total),
          'line_items[0][price_data][product_data][name]': description,
          ...(payer.email && !payer.email.endsWith('.invalid') ? { customer_email: payer.email } : {}),
        });
        await this.platform.payment.update({ where: { id: payment.id }, data: { gatewayOrderId: session.id } });
        return { paymentId: payment.id, gateway, amount: price.total, currency: ws.currency, redirectUrl: session.url };
      }
      const order = await paypal<{ id?: string; links?: { rel: string; href: string }[]; message?: string }>(creds, 'POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: payment.id, custom_id: payment.id, description: description.slice(0, 120), amount: { currency_code: ws.currency, value: price.total.toFixed(2) } }],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'We School', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
              return_url: `${web}/admin/subscription?gateway=paypal`, cancel_url: `${web}/admin/subscription?cancelled=1`,
            },
          },
        },
      });
      const link = order.json.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
      if (!order.json.id || !link) throw new Error(`PayPal: ${order.json.message ?? `HTTP ${order.status}`}`);
      await this.platform.payment.update({ where: { id: payment.id }, data: { gatewayOrderId: order.json.id } });
      return { paymentId: payment.id, gateway, amount: price.total, currency: ws.currency, redirectUrl: link };
    } catch (err) {
      await this.platform.payment.update({ where: { id: payment.id }, data: { status: 'failed', failureReason: (err as Error).message.slice(0, 300) } });
      throw new AppError(502, 'GATEWAY_ERROR', `The payment could not be started: ${(err as Error).message}`);
    }
  }

  /** Razorpay Checkout's success callback, verified by signature and with Razorpay. */
  async verifyRazorpay(workspaceId: string, body: { paymentId: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) {
    const payment = await this.platform.payment.findFirst({ where: { id: body.paymentId, workspaceId } });
    if (!payment || payment.gatewayOrderId !== body.razorpayOrderId) throw notFound('Payment');
    const creds = await this.gateways.get(payment.gateway as GatewayKey);
    if (!razorpayCheckoutValid(creds.secrets.keySecret ?? '', body.razorpayOrderId, body.razorpayPaymentId, body.razorpaySignature)) {
      throw new AppError(400, 'SIGNATURE_INVALID', 'The payment could not be verified');
    }
    const p = await razorpay<{ status: string; method?: string; amount: number; currency: string }>(creds, 'GET', `/payments/${body.razorpayPaymentId}`);
    if (p.status === 'authorized') await razorpay(creds, 'POST', `/payments/${body.razorpayPaymentId}/capture`, { amount: p.amount, currency: p.currency });
    else if (p.status !== 'captured') throw new AppError(402, 'PAYMENT_NOT_CAPTURED', `The payment is ${p.status}`);
    return this.settle(payment.id, { gatewayPaymentId: body.razorpayPaymentId, method: p.method ?? null });
  }

  /** The browser came back from Stripe or PayPal: ask the gateway, then settle. */
  async confirmRedirect(workspaceId: string, gateway: 'stripe' | 'paypal', ref: string) {
    const payment = await this.platform.payment.findFirst({ where: { workspaceId, gatewayOrderId: ref, gateway } });
    if (!payment) throw notFound('Payment');
    if (payment.status === 'paid') return this.settledResult(payment.id);
    const creds = await this.gateways.get(gateway);
    if (gateway === 'stripe') {
      const s = await stripe<{ payment_status: string; payment_intent?: string }>(creds, 'GET', `/checkout/sessions/${encodeURIComponent(ref)}`);
      if (s.payment_status !== 'paid') throw new AppError(402, 'PAYMENT_NOT_COMPLETED', 'The payment has not completed yet');
      return this.settle(payment.id, { gatewayPaymentId: s.payment_intent ?? null, method: 'card' });
    }
    const captured = await this.capturePaypal(creds, ref);
    return this.settle(payment.id, { gatewayPaymentId: captured, method: 'paypal' });
  }

  /** Captures an approved PayPal order (or finds the capture when it was already captured). */
  async capturePaypal(creds: Awaited<ReturnType<GatewayConfigs['get']>>, orderId: string): Promise<string> {
    type Capture = { status?: string; purchase_units?: { payments?: { captures?: { id: string; status: string }[] } }[]; details?: { issue: string }[] };
    let r = await paypal<Capture>(creds, 'POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {});
    if (r.status === 422 && r.json.details?.some((d) => d.issue === 'ORDER_ALREADY_CAPTURED')) r = await paypal<Capture>(creds, 'GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    const capture = r.json.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture || capture.status !== 'COMPLETED') throw new AppError(402, 'PAYMENT_NOT_COMPLETED', 'The PayPal payment has not completed');
    return capture.id;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Settling a payment (idempotent)
  // -------------------------------------------------------------------------------------------------------------

  async settle(paymentId: string, info: { gatewayPaymentId?: string | null; method?: string | null; paidAt?: Date; note?: string }) {
    const existing = await this.platform.payment.findUnique({ where: { id: paymentId } });
    if (!existing) throw notFound('Payment');
    if (existing.status === 'paid') return this.settledResult(paymentId);
    const ws = await this.platform.workspace.findUniqueOrThrow({ where: { id: existing.workspaceId } });
    const plan = await this.plan(existing.planCode);
    const taxPercent = Number(await this.settings.get<number>(ws.currency === 'USD' ? 'billing.tax_percent_usd' : 'billing.tax_percent_inr')) || 0;
    const [legalName, address, taxId, supportEmail, prefix] = await Promise.all([
      this.settings.get<string>('billing.legal_name'), this.settings.get<string>('billing.address'), this.settings.get<string>('billing.tax_id'),
      this.settings.get<string>('billing.support_email'), this.settings.get<string>('billing.invoice_prefix'),
    ]);

    const outcome = await this.platform.$transaction(async (tx) => {
      // Only one settle wins: the status flips from initiated to paid exactly once.
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, status: { not: 'paid' } },
        data: { status: 'paid', paidAt: info.paidAt ?? new Date(), gatewayPaymentId: info.gatewayPaymentId ?? undefined, method: info.method ?? undefined, failureReason: null },
      });
      if (claimed.count === 0) return null;
      const latest = await tx.subscriptionPeriod.findFirst({ where: { workspaceId: ws.id }, orderBy: { endsOn: 'desc' } });
      const today = todayIn(ws.timezone);
      const after = latest ? addDays(dateKey(latest.endsOn), 1) : today;
      const startsOn = after > today ? after : today;
      const endsOn = periodEnd(startsOn, plan.months);
      const source = existing.gateway === 'manual' ? 'manual' : existing.gateway;
      await tx.subscriptionPeriod.create({
        data: { workspaceId: ws.id, planCode: plan.code, startsOn: dbDate(startsOn), endsOn: dbDate(endsOn), source, paymentId, note: info.note ?? null },
      });
      const year = new Date().getUTCFullYear();
      const counter = await tx.platformCounter.upsert({ where: { key: `invoice:${year}` }, create: { key: `invoice:${year}`, value: 1 }, update: { value: { increment: 1 } } });
      const total = num(existing.amount);
      const subtotal = round2(total / (1 + taxPercent / 100));
      const invoice = await tx.invoice.create({
        data: {
          number: `${prefix || 'WS-INV'}-${year}-${String(counter.value).padStart(4, '0')}`,
          workspaceId: ws.id, paymentId, planCode: plan.code, periodStart: dbDate(startsOn), periodEnd: dbDate(endsOn), currency: existing.currency,
          subtotal, taxPercent, taxAmount: round2(total - subtotal), total,
          seller: { name: legalName || 'We School', address, taxId, email: supportEmail },
          billTo: { name: ws.name, address: ws.address, taxId: ws.taxId, contact: ws.contactName, email: ws.contactEmail },
        },
      });
      await tx.payment.update({ where: { id: paymentId }, data: { invoiceId: invoice.id } });
      return { startsOn, endsOn, invoiceId: invoice.id, invoiceNumber: invoice.number };
    });
    this.status.invalidate(ws.id);
    if (!outcome) return this.settledResult(paymentId);
    void this.announce(ws.id, paymentId, plan.name, outcome).catch((err) => this.log.warn(`Receipt not sent: ${(err as Error).message}`));
    return { paymentId, ...outcome, alreadySettled: false };
  }

  private async settledResult(paymentId: string) {
    const p = await this.platform.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const period = await this.platform.subscriptionPeriod.findFirst({ where: { paymentId } });
    const invoice = p.invoiceId ? await this.platform.invoice.findUnique({ where: { id: p.invoiceId } }) : null;
    return {
      paymentId, startsOn: period ? dateKey(period.startsOn) : null, endsOn: period ? dateKey(period.endsOn) : null,
      invoiceId: invoice?.id ?? null, invoiceNumber: invoice?.number ?? null, alreadySettled: true,
    };
  }

  /** Receipt email to the school's billing contact and admins, and a notification inside the school. */
  private async announce(workspaceId: string, paymentId: string, planName: string, o: { startsOn: string; endsOn: string; invoiceId: string; invoiceNumber: string }) {
    const ws = await this.tenancy.byId(workspaceId);
    const row = await this.platform.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws || !row) return;
    const admins = await this.schoolAdminEmails(ws.id);
    const pdf = await this.invoicePdf(o.invoiceId);
    await this.mailer.send(
      [row.contactEmail ?? '', ...admins],
      `We School receipt ${o.invoiceNumber} — ${row.name}`,
      `Thank you. We received the payment for the ${planName} plan.\n\nSchool: ${row.name}\nSubscription: ${o.startsOn} to ${o.endsOn}\nInvoice: ${o.invoiceNumber} (attached)\n\nWe School`,
      [{ filename: `${o.invoiceNumber}.pdf`, content: pdf.bytes, contentType: 'application/pdf' }],
    );
    await this.tenancy.run(ws, () =>
      this.notifications.notifyPermission('subscription.manage', {
        category: 'Completed', topic: 'system', module: 'subscription', icon: 'check',
        title: `We School subscription renewed until ${o.endsOn}`, body: `${planName} plan · invoice ${o.invoiceNumber}`, route: '/admin/subscription',
      }),
    );
    void paymentId;
  }

  /** Emails of a school's Workspace Admins (not the hidden support account). */
  async schoolAdminEmails(workspaceId: string): Promise<string[]> {
    const ws = await this.tenancy.byId(workspaceId);
    if (!ws) return [];
    const users = await this.tenancy.withSchool(ws, () => this.tenancy.current().user.findMany({
      where: { status: 'active', role: { key: 'super_admin' }, NOT: { email: { endsWith: `.${SUPPORT_EMAIL_DOMAIN}` } } },
      select: { email: true },
    }));
    return users.map((u) => u.email);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Invoices
  // -------------------------------------------------------------------------------------------------------------

  async invoicePdf(invoiceId: string, workspaceId?: string): Promise<{ number: string; bytes: Uint8Array }> {
    const inv = await this.platform.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv || (workspaceId && inv.workspaceId !== workspaceId)) throw notFound('Invoice');
    const [payment, plan, taxLabel] = await Promise.all([
      this.platform.payment.findUnique({ where: { id: inv.paymentId } }),
      this.platform.plan.findUnique({ where: { code: inv.planCode } }),
      this.settings.get<string>('billing.tax_label'),
    ]);
    const seller = inv.seller as { name: string; address?: string; taxId?: string; email?: string };
    const billTo = inv.billTo as { name: string; address?: string | null; taxId?: string | null; contact?: string | null; email?: string | null };
    const bytes = await renderInvoicePdf({
      number: inv.number, issuedAt: inv.issuedAt, currency: inv.currency,
      subtotal: num(inv.subtotal), taxPercent: num(inv.taxPercent), taxAmount: num(inv.taxAmount), total: num(inv.total), taxLabel: taxLabel || 'Tax',
      description: `We School subscription - ${plan?.name ?? inv.planCode} plan`,
      periodStart: dateKey(inv.periodStart), periodEnd: dateKey(inv.periodEnd),
      seller, billTo,
      payment: { method: payment?.method ?? null, reference: payment?.reference ?? payment?.gatewayPaymentId ?? null, paidAt: payment?.paidAt ?? null, gateway: payment?.gateway ?? 'manual' },
    });
    return { number: inv.number, bytes };
  }

  /** Online checkouts nobody finished within six hours are marked failed. */
  async expireStaleCheckouts() {
    const r = await this.platform.payment.updateMany({
      where: { status: 'initiated', gateway: { not: 'manual' }, createdAt: { lt: new Date(Date.now() - STALE_CHECKOUT_MS) } },
      data: { status: 'failed', failureReason: 'Checkout was not completed' },
    });
    if (r.count) this.log.log(`${r.count} unfinished checkout(s) marked failed`);
  }
}
