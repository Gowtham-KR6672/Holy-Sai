import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CryptoService } from '../../common/crypto.service';
import { badRequest, notFound } from '../../common/errors';
import { PlatformDb, type PlatformPrisma } from '../../tenancy/platform-db.service';

export type GatewayKey = 'razorpay' | 'razorpay_intl' | 'stripe' | 'paypal';

interface FieldDef {
  key: string;
  label: string;
  hint?: string;
}

/** The subscription gateways We School offers schools, by billing currency. */
export const GATEWAYS: Record<GatewayKey, { label: string; currency: 'INR' | 'USD'; fields: FieldDef[]; secrets: FieldDef[]; webhookPath: string }> = {
  razorpay: {
    label: 'Razorpay', currency: 'INR', webhookPath: '/api/platform/webhooks/razorpay',
    fields: [{ key: 'keyId', label: 'Key ID', hint: 'rzp_test_… or rzp_live_…' }],
    secrets: [{ key: 'keySecret', label: 'Key secret' }, { key: 'webhookSecret', label: 'Webhook secret' }],
  },
  razorpay_intl: {
    label: 'Razorpay International', currency: 'USD', webhookPath: '/api/platform/webhooks/razorpay',
    fields: [{ key: 'keyId', label: 'Key ID', hint: 'The account must have international payments switched on' }],
    secrets: [{ key: 'keySecret', label: 'Key secret' }, { key: 'webhookSecret', label: 'Webhook secret' }],
  },
  stripe: {
    label: 'Stripe', currency: 'USD', webhookPath: '/api/platform/webhooks/stripe',
    fields: [{ key: 'publishableKey', label: 'Publishable key', hint: 'pk_test_… or pk_live_…' }],
    secrets: [{ key: 'secretKey', label: 'Secret key', hint: 'sk_test_… or sk_live_…' }, { key: 'webhookSecret', label: 'Webhook signing secret', hint: 'whsec_…' }],
  },
  paypal: {
    label: 'PayPal', currency: 'USD', webhookPath: '/api/platform/webhooks/paypal',
    fields: [{ key: 'clientId', label: 'Client ID' }, { key: 'webhookId', label: 'Webhook ID', hint: 'From the PayPal app’s webhook settings' }],
    secrets: [{ key: 'clientSecret', label: 'Client secret' }],
  },
};

export const GATEWAY_KEYS = Object.keys(GATEWAYS) as GatewayKey[];

export interface GatewayCreds {
  gateway: GatewayKey;
  isEnabled: boolean;
  mode: 'test' | 'live';
  config: Record<string, string>;
  secrets: Record<string, string>;
}

const MASK = '••••••••';

/** We School's own gateway accounts (keys encrypted at rest), with a Test button per gateway. */
@Injectable()
export class GatewayConfigs {
  constructor(
    private readonly platform: PlatformDb,
    private readonly crypto: CryptoService,
  ) {}

  async get(gateway: GatewayKey): Promise<GatewayCreds> {
    if (!GATEWAYS[gateway]) throw notFound('Gateway');
    const row = await this.platform.gatewayConfig.findUnique({ where: { gateway } });
    const secrets = row?.secretsEnc ? (JSON.parse(this.crypto.decrypt(row.secretsEnc)) as Record<string, string>) : {};
    return { gateway, isEnabled: !!row?.isEnabled, mode: row?.mode === 'live' ? 'live' : 'test', config: (row?.config ?? {}) as Record<string, string>, secrets };
  }

  /** Enabled gateways that can take payments in a currency. */
  async availableFor(currency: string): Promise<GatewayKey[]> {
    const rows = await this.platform.gatewayConfig.findMany({ where: { isEnabled: true } });
    return GATEWAY_KEYS.filter((g) => GATEWAYS[g].currency === currency && rows.some((r) => r.gateway === g));
  }

  /** For the console: settings with secrets masked. */
  async list() {
    const rows = await this.platform.gatewayConfig.findMany();
    return GATEWAY_KEYS.map((g) => {
      const row = rows.find((r) => r.gateway === g);
      const def = GATEWAYS[g];
      const stored = row?.secretsEnc ? (JSON.parse(this.crypto.decrypt(row.secretsEnc)) as Record<string, string>) : {};
      return {
        gateway: g, label: def.label, currency: def.currency, webhookPath: def.webhookPath,
        fields: def.fields, secretFields: def.secrets,
        isEnabled: !!row?.isEnabled, mode: row?.mode ?? 'test',
        config: (row?.config ?? {}) as Record<string, string>,
        secrets: Object.fromEntries(def.secrets.map((s) => [s.key, stored[s.key] ? MASK : ''])),
        lastTestedAt: row?.lastTestedAt?.toISOString() ?? null, lastTestOk: row?.lastTestOk ?? null, lastTestMessage: row?.lastTestMessage ?? null,
      };
    });
  }

  async save(gateway: GatewayKey, body: { isEnabled?: boolean; mode?: string; config?: Record<string, string>; secrets?: Record<string, string> }, adminId: string) {
    const def = GATEWAYS[gateway];
    if (!def) throw notFound('Gateway');
    const current = await this.get(gateway);
    const config = { ...current.config };
    for (const f of def.fields) if (body.config && f.key in body.config) config[f.key] = String(body.config[f.key] ?? '').trim();
    const secrets = { ...current.secrets };
    for (const s of def.secrets) {
      const v = body.secrets?.[s.key];
      if (v === undefined || v === MASK) continue;
      if (v === '') delete secrets[s.key];
      else secrets[s.key] = String(v).trim();
    }
    const mode = body.mode === 'live' ? 'live' : body.mode === 'test' ? 'test' : current.mode;
    const isEnabled = body.isEnabled ?? current.isEnabled;
    if (isEnabled) {
      const missing = [...def.fields.filter((f) => f.key !== 'webhookId' && !config[f.key]), ...def.secrets.filter((s) => s.key !== 'webhookSecret' && !secrets[s.key])];
      if (missing.length) throw badRequest(`Fill in ${missing.map((m) => m.label).join(', ')} before switching ${def.label} on`);
    }
    await this.platform.gatewayConfig.upsert({
      where: { gateway },
      create: { gateway, isEnabled, mode, config: config as PlatformPrisma.InputJsonValue, secretsEnc: this.crypto.encrypt(JSON.stringify(secrets)), updatedById: adminId },
      update: { isEnabled, mode, config: config as PlatformPrisma.InputJsonValue, secretsEnc: this.crypto.encrypt(JSON.stringify(secrets)), updatedById: adminId },
    });
  }

  /** Calls the gateway with the saved keys and records the outcome. */
  async test(gateway: GatewayKey): Promise<{ ok: boolean; message: string }> {
    const c = await this.get(gateway);
    let result: { ok: boolean; message: string };
    try {
      if (gateway === 'razorpay' || gateway === 'razorpay_intl') {
        await razorpay(c, 'GET', '/payments?count=1');
        result = { ok: true, message: `Connected to Razorpay (${(c.config.keyId ?? '').startsWith('rzp_live') ? 'live' : 'test'} keys)` };
      } else if (gateway === 'stripe') {
        await stripe(c, 'GET', '/balance');
        result = { ok: true, message: `Connected to Stripe (${(c.secrets.secretKey ?? '').startsWith('sk_live') ? 'live' : 'test'} keys)` };
      } else {
        await paypalToken(c);
        result = { ok: true, message: `Connected to PayPal (${c.mode === 'live' ? 'live' : 'sandbox'})` };
      }
    } catch (err) {
      result = { ok: false, message: (err as Error).message.slice(0, 300) };
    }
    await this.platform.gatewayConfig.updateMany({ where: { gateway }, data: { lastTestedAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message } });
    return result;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP clients (no SDKs: plain fetch with timeouts)
// ---------------------------------------------------------------------------------------------------------------

/** Razorpay REST call (Basic auth with the key id and secret). */
export async function razorpay<T = Record<string, unknown>>(c: GatewayCreds, method: string, path: string, body?: unknown): Promise<T> {
  const auth = Buffer.from(`${c.config.keyId ?? ''}:${c.secrets.keySecret ?? ''}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { description?: string } };
  if (!res.ok) throw new Error(`Razorpay: ${json.error?.description ?? `HTTP ${res.status}`}`);
  return json as T;
}

/** Stripe REST call (form-encoded, bearer secret key). */
export async function stripe<T = Record<string, unknown>>(c: GatewayCreds, method: string, path: string, form?: Record<string, string | number>): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${c.secrets.secretKey ?? ''}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form ? new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) throw new Error(`Stripe: ${json.error?.message ?? `HTTP ${res.status}`}`);
  return json as T;
}

const paypalBase = (c: GatewayCreds) => (c.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
const paypalTokens = new Map<string, { token: string; until: number }>();

/** A PayPal OAuth access token (client credentials), cached until shortly before it expires. */
export async function paypalToken(c: GatewayCreds): Promise<string> {
  const cacheKey = `${c.mode}:${c.config.clientId}`;
  const hit = paypalTokens.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.token;
  const res = await fetch(`${paypalBase(c)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${c.config.clientId ?? ''}:${c.secrets.clientSecret ?? ''}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`PayPal: ${json.error_description ?? `HTTP ${res.status}`}`);
  paypalTokens.set(cacheKey, { token: json.access_token, until: Date.now() + Math.max(60, (json.expires_in ?? 300) - 60) * 1000 });
  return json.access_token;
}

/** PayPal REST call with a bearer token. Returns { status, json } so callers can handle "already captured". */
export async function paypal<T = Record<string, unknown>>(c: GatewayCreds, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const token = await paypalToken(c);
  const res = await fetch(`${paypalBase(c)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------------------------------------------

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const hmacHex = (secret: string, payload: string | Buffer) => createHmac('sha256', secret).update(payload).digest('hex');

/** Razorpay Checkout: HMAC-SHA256 of "order_id|payment_id" with the key secret. */
export const razorpayCheckoutValid = (keySecret: string, orderId: string, paymentId: string, signature: string) =>
  safeEqual(hmacHex(keySecret, `${orderId}|${paymentId}`), signature);

/** Stripe webhooks: "t=…,v1=…" — HMAC-SHA256 of "t.payload" with the endpoint secret, within 5 minutes. */
export function stripeSignatureValid(secret: string, header: string, rawBody: string, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]).filter((p) => p.length === 2)) as Record<string, string>;
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = hmacHex(secret, `${t}.${rawBody}`);
  return header.split(',').some((p) => p.startsWith('v1=') && safeEqual(p.slice(3), expected));
}
