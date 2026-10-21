import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, Public, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { AppError, notFound } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { currentWorkspace } from '../../tenancy/context';
import { PlatformDb } from '../../tenancy/platform-db.service';
import { PlatformSettings } from '../../tenancy/platform-settings.service';
import { PlatformAudit } from '../platform-audit.service';
import { CurrentAdmin, PlatformGuard, type PlatformAdminUser } from '../platform.guard';
import { BillingService } from './billing.service';
import { GATEWAY_KEYS, GatewayConfigs, type GatewayKey, hmacHex, paypal, safeEqual, stripeSignatureValid } from './gateways';
import { PlatformMailer } from './platform-mailer.service';

class PlanDto {
  @IsOptional() @IsNumber() @Min(0) priceInr?: number;
  @IsOptional() @IsNumber() @Min(0) priceUsd?: number;
  @IsOptional() isActive?: boolean;
  @IsOptional() @IsString() @MaxLength(60) name?: string;
}

class StartDto {
  @IsString() planCode: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) startsOn?: string;
  @IsOptional() @IsInt() @Min(1) @Max(366) trialDays?: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class ExtendDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Choose a date' }) endsOn: string;
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

class ManualPaymentDto {
  @IsString() planCode: string;
  @IsNumber({}, { message: 'Enter the amount received' }) @Min(0.01) amount: number;
  @IsIn(['bank', 'upi', 'cheque', 'cash', 'card', 'other']) method: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) paidOn?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class GatewayDto {
  @IsOptional() isEnabled?: boolean;
  @IsOptional() @IsIn(['test', 'live']) mode?: string;
  @IsOptional() config?: Record<string, string>;
  @IsOptional() secrets?: Record<string, string>;
}

class PaymentsQuery extends ListQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() workspaceId?: string;
}

class CheckoutDto {
  @IsString() planCode: string;
  @IsIn(GATEWAY_KEYS) gateway: GatewayKey;
}

class RazorpayVerifyDto {
  @IsString() paymentId: string;
  @IsString() razorpayOrderId: string;
  @IsString() razorpayPaymentId: string;
  @IsString() razorpaySignature: string;
}

class ConfirmDto {
  @IsIn(['stripe', 'paypal']) gateway: 'stripe' | 'paypal';
  @IsString() @MinLength(5) @MaxLength(200) ref: string;
}

const pdfFile = (res: Response, number: string, bytes: Uint8Array) => {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${number}.pdf"` });
  return new StreamableFile(Buffer.from(bytes));
};

/** Plans, payments, gateways, platform settings and each school's subscription (platform admins). */
@Public()
@UseGuards(PlatformGuard)
@Controller('platform')
export class PlatformBillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly gateways: GatewayConfigs,
    private readonly settings: PlatformSettings,
    private readonly mailer: PlatformMailer,
    private readonly platform: PlatformDb,
    private readonly audit: PlatformAudit,
  ) {}

  @Get('plans')
  plans() {
    return this.billing.plans();
  }

  @Put('plans/:code')
  async updatePlan(@Param('code') code: string, @Body() dto: PlanDto, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    await this.billing.updatePlan(code, dto, admin, req);
    return ok({ code }, 'Plan updated');
  }

  @Get('payments')
  async payments(@Query() q: PaymentsQuery) {
    const p = pageOf(q);
    const where = { ...(q.status ? { status: q.status } : {}), ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}) };
    const [rows, total, schools] = await Promise.all([
      this.platform.payment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
      this.platform.payment.count({ where }),
      this.platform.workspace.findMany({ select: { id: true, name: true, code: true, status: true } }),
    ]);
    const byId = new Map(schools.map((s) => [s.id, s]));
    return paged(
      rows.map((r) => ({
        id: r.id, school: byId.get(r.workspaceId)?.name ?? '—', planCode: r.planCode,
        // A deleted school keeps its payments, but has no page to open.
        schoolCode: byId.get(r.workspaceId)?.status === 'deleted' ? null : byId.get(r.workspaceId)?.code ?? null,
        schoolDeleted: byId.get(r.workspaceId)?.status === 'deleted',
        amount: Number(r.amount), currency: r.currency, gateway: r.gateway, method: r.method, status: r.status,
        reference: r.reference ?? r.gatewayPaymentId, paidAt: r.paidAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), invoiceId: r.invoiceId, failureReason: r.failureReason,
      })),
      total,
      p,
    );
  }

  @Get('gateways')
  listGateways() {
    return this.gateways.list();
  }

  @Put('gateways/:gateway')
  async saveGateway(@Param('gateway') gateway: GatewayKey, @Body() dto: GatewayDto, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    await this.gateways.save(gateway, dto, admin.id);
    await this.audit.record({ admin, action: 'update', entityType: 'gateway', entityId: gateway, description: `Updated the ${gateway} payment gateway${dto.isEnabled === false ? ' (switched off)' : ''}`, req });
    return ok({ gateway }, 'Gateway saved');
  }

  @Post('gateways/:gateway/test')
  @HttpCode(200)
  async testGateway(@Param('gateway') gateway: GatewayKey) {
    const r = await this.gateways.test(gateway);
    if (!r.ok) throw new AppError(400, 'GATEWAY_TEST_FAILED', r.message);
    return ok(r, r.message);
  }

  @Get('settings')
  allSettings() {
    return this.settings.all();
  }

  @Put('settings')
  async saveSettings(@Body() body: Record<string, unknown>, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    await this.settings.update(body ?? {}, admin.id);
    await this.audit.record({ admin, action: 'update', entityType: 'settings', description: `Updated platform settings (${Object.keys(body ?? {}).join(', ')})`, req });
    return ok(await this.settings.all(), 'Settings saved');
  }

  @Post('settings/test-email')
  @HttpCode(200)
  async testEmail(@CurrentAdmin() admin: PlatformAdminUser) {
    const v = await this.mailer.verify();
    if (!v.ok) throw new AppError(400, 'EMAIL_TEST_FAILED', v.message);
    const sent = await this.mailer.send([admin.email], 'We School email test', 'This is a test message from the We School console.');
    return ok({ sent }, sent ? `${v.message} — a test email was sent to ${admin.email}` : v.message);
  }

  @Get('workspaces/:id/subscription')
  async subscription(@Param('id') id: string) {
    return this.billing.summary(await this.schoolId(id));
  }

  @Post('workspaces/:id/subscription/start')
  async start(@Param('id') id: string, @Body() dto: StartDto, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    await this.billing.start(await this.schoolId(id), dto, admin, req);
    return ok(null, dto.trialDays ? 'Trial started' : 'Subscription started');
  }

  @Post('workspaces/:id/subscription/extend')
  async extend(@Param('id') id: string, @Body() dto: ExtendDto, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    await this.billing.extendTo(await this.schoolId(id), dto.endsOn, dto.reason, admin, req);
    return ok(null, `Extended to ${dto.endsOn}`);
  }

  @Post('workspaces/:id/payments')
  async recordPayment(@Param('id') id: string, @Body() dto: ManualPaymentDto, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    const r = await this.billing.recordManual(await this.schoolId(id), dto, admin, req);
    return ok(r, `Payment recorded — subscription runs until ${r.endsOn}`);
  }

  @Get('invoices/:id/pdf')
  async invoice(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const pdf = await this.billing.invoicePdf(id);
    return pdfFile(res, pdf.number, pdf.bytes);
  }

  private async schoolId(idOrCode: string): Promise<string> {
    const w = await this.platform.workspace.findFirst({ where: { status: { not: 'deleted' }, OR: [{ code: idOrCode }, ...(/^[0-9a-f-]{36}$/i.test(idOrCode) ? [{ id: idOrCode }] : [])] }, select: { id: true } });
    if (!w) throw notFound('School');
    return w.id;
  }
}

/** The school's own Subscription page (Workspace Admins): status, renewal and invoices. Reachable after expiry. */
@Controller('subscription')
@RequirePermissions('subscription.manage')
export class SchoolSubscriptionController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  summary() {
    return this.billing.summary(currentWorkspace().id);
  }

  @Post('checkout')
  @HttpCode(200)
  checkout(@Body() dto: CheckoutDto, @CurrentUser() user: AuthUser) {
    return this.billing.checkout(currentWorkspace().id, dto.planCode, dto.gateway, { userId: user.id, name: user.fullName, email: user.email });
  }

  @Post('razorpay/verify')
  @HttpCode(200)
  async verify(@Body() dto: RazorpayVerifyDto) {
    const r = await this.billing.verifyRazorpay(currentWorkspace().id, dto);
    return ok(r, `Thank you — your subscription runs until ${r.endsOn}`);
  }

  @Post('confirm')
  @HttpCode(200)
  async confirm(@Body() dto: ConfirmDto) {
    const r = await this.billing.confirmRedirect(currentWorkspace().id, dto.gateway, dto.ref);
    return ok(r, `Thank you — your subscription runs until ${r.endsOn}`);
  }

  @Get('invoices/:id/pdf')
  async invoice(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const pdf = await this.billing.invoicePdf(id, currentWorkspace().id);
    return pdfFile(res, pdf.number, pdf.bytes);
  }
}

type RawRequest = Request & { rawBody?: Buffer };
const rawOf = (req: RawRequest) => (req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body ?? {}));

/**
 * Gateway webhooks for subscription payments. Each delivery is verified (Razorpay and Stripe: HMAC of the raw body;
 * PayPal: PayPal's verify-webhook-signature API) and handled once (GatewayEvent).
 */
@Public()
@Controller('platform/webhooks')
export class PaymentWebhooksController {
  constructor(
    private readonly billing: BillingService,
    private readonly gateways: GatewayConfigs,
    private readonly platform: PlatformDb,
  ) {}

  private async seen(gateway: string, eventId: string | undefined) {
    return !!eventId && !!(await this.platform.gatewayEvent.findUnique({ where: { gateway_eventId: { gateway, eventId } } }));
  }

  private async remember(gateway: string, eventId: string | undefined, type: string | undefined) {
    if (eventId) await this.platform.gatewayEvent.create({ data: { gateway, eventId, type: type ?? null } }).catch(() => undefined);
  }

  private async settleByOrder(gatewayOrderId: string | undefined, gatewayPaymentId: string | null, method: string | null) {
    if (!gatewayOrderId) return 'ignored';
    const payment = await this.platform.payment.findUnique({ where: { gatewayOrderId } });
    if (!payment) return 'unknown order';
    await this.billing.settle(payment.id, { gatewayPaymentId, method });
    return 'settled';
  }

  private async failByOrder(gatewayOrderId: string | undefined, reason: string) {
    if (!gatewayOrderId) return;
    await this.platform.payment.updateMany({ where: { gatewayOrderId, status: 'initiated' }, data: { status: 'failed', failureReason: reason.slice(0, 300) } });
  }

  @Post('razorpay')
  @HttpCode(200)
  async razorpay(@Req() req: RawRequest, @Headers('x-razorpay-signature') signature: string, @Headers('x-razorpay-event-id') eventId: string) {
    const raw = rawOf(req);
    const secrets = (await Promise.all((['razorpay', 'razorpay_intl'] as const).map((g) => this.gateways.get(g)))).map((c) => c.secrets.webhookSecret).filter(Boolean) as string[];
    if (!signature || !secrets.some((s) => safeEqual(hmacHex(s, raw), signature))) throw new AppError(401, 'SIGNATURE_INVALID', 'Invalid signature');
    if (await this.seen('razorpay', eventId)) return { received: true, duplicate: true };
    const body = req.body as { event?: string; payload?: { payment?: { entity?: { id: string; order_id?: string; method?: string; error_description?: string } } } };
    const entity = body.payload?.payment?.entity;
    let outcome = 'ignored';
    if (body.event === 'payment.captured' || body.event === 'order.paid') outcome = await this.settleByOrder(entity?.order_id, entity?.id ?? null, entity?.method ?? null);
    else if (body.event === 'payment.failed') await this.failByOrder(entity?.order_id, entity?.error_description ?? 'Payment failed');
    await this.remember('razorpay', eventId, body.event);
    return { received: true, outcome };
  }

  @Post('stripe')
  @HttpCode(200)
  async stripe(@Req() req: RawRequest, @Headers('stripe-signature') signature: string) {
    const creds = await this.gateways.get('stripe');
    const raw = rawOf(req);
    if (!signature || !creds.secrets.webhookSecret || !stripeSignatureValid(creds.secrets.webhookSecret, signature, raw)) {
      throw new AppError(400, 'SIGNATURE_INVALID', 'Invalid signature');
    }
    const event = req.body as { id?: string; type?: string; data?: { object?: { id: string; payment_status?: string; payment_intent?: string } } };
    if (await this.seen('stripe', event.id)) return { received: true, duplicate: true };
    const s = event.data?.object;
    let outcome = 'ignored';
    if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && s?.payment_status === 'paid') {
      outcome = await this.settleByOrder(s.id, s.payment_intent ?? null, 'card');
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      await this.failByOrder(s?.id, 'Checkout expired or failed');
    }
    await this.remember('stripe', event.id, event.type);
    return { received: true, outcome };
  }

  @Post('paypal')
  @HttpCode(200)
  async paypal(@Req() req: RawRequest, @Headers() headers: Record<string, string>) {
    const creds = await this.gateways.get('paypal');
    const event = req.body as { id?: string; event_type?: string; resource?: { id?: string; status?: string; supplementary_data?: { related_ids?: { order_id?: string } } } };
    if (!creds.config.webhookId) throw new AppError(400, 'NOT_CONFIGURED', 'PayPal webhook ID is not set');
    const check = await paypal<{ verification_status?: string }>(creds, 'POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'],
      webhook_id: creds.config.webhookId, webhook_event: event,
    });
    if (check.json.verification_status !== 'SUCCESS') throw new AppError(400, 'SIGNATURE_INVALID', 'Invalid signature');
    if (await this.seen('paypal', event.id)) return { received: true, duplicate: true };
    let outcome = 'ignored';
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      outcome = await this.settleByOrder(event.resource?.supplementary_data?.related_ids?.order_id, event.resource?.id ?? null, 'paypal');
    } else if (event.event_type === 'CHECKOUT.ORDER.APPROVED' && event.resource?.id) {
      const payment = await this.platform.payment.findUnique({ where: { gatewayOrderId: event.resource.id } });
      if (payment && payment.status !== 'paid') {
        const captureId = await this.billing.capturePaypal(creds, event.resource.id);
        await this.billing.settle(payment.id, { gatewayPaymentId: captureId, method: 'paypal' });
        outcome = 'settled';
      }
    } else if (event.event_type === 'PAYMENT.CAPTURE.DENIED') {
      await this.failByOrder(event.resource?.supplementary_data?.related_ids?.order_id, 'Payment denied');
    }
    await this.remember('paypal', event.id, event.event_type);
    return { received: true, outcome };
  }
}
