import { Injectable } from '@nestjs/common';
import type { Integration } from '@prisma/client';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { INTEGRATION_FIELDS, INTEGRATION_KINDS, type IntegrationKind } from '@holysai/shared';
import { CryptoService } from '../../common/crypto.service';
import { badRequest } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { workspaceUploadDir } from '../../tenancy/uploads';
import { s3ConfigFrom, s3Delete, s3Get, s3Put } from './s3';

const MASK = '••••••••';

export interface ResolvedIntegration {
  kind: IntegrationKind;
  provider: string | null;
  isEnabled: boolean;
  config: Record<string, string>;
  secrets: Record<string, string>;
}

export interface IntegrationView {
  kind: IntegrationKind;
  label: string;
  providers: readonly string[];
  provider: string | null;
  isEnabled: boolean;
  /** Non-secret settings; secrets come back masked. */
  config: Record<string, string>;
  status: 'not_configured' | 'configured' | 'ok' | 'failed';
  lastTestedAt: string | null;
  lastTestMessage: string | null;
}

/** Stores integration settings (secrets encrypted) and tests each connection. */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  isKind(kind: string): kind is IntegrationKind {
    return INTEGRATION_KINDS.some((k) => k.id === kind);
  }

  async list(): Promise<IntegrationView[]> {
    const rows = await this.prisma.integration.findMany();
    return INTEGRATION_KINDS.map((k) => this.view(k.id, rows.find((r) => r.kind === k.id) ?? null));
  }

  async get(kind: IntegrationKind): Promise<ResolvedIntegration> {
    const row = await this.prisma.integration.findUnique({ where: { kind } });
    return {
      kind,
      provider: row?.provider ?? null,
      isEnabled: row?.isEnabled ?? false,
      config: (row?.config as Record<string, string>) ?? {},
      secrets: row?.secretsEnc ? (JSON.parse(this.crypto.decrypt(row.secretsEnc)) as Record<string, string>) : {},
    };
  }

  async save(kind: IntegrationKind, input: { provider?: string; isEnabled?: boolean; config?: Record<string, string> }) {
    const def = INTEGRATION_KINDS.find((k) => k.id === kind)!;
    if (input.provider && !(def.providers as readonly string[]).includes(input.provider)) throw badRequest('Unknown provider');
    const current = await this.get(kind);
    const config = { ...current.config };
    const secrets = { ...current.secrets };
    for (const f of INTEGRATION_FIELDS[kind]) {
      const v = input.config?.[f.key];
      if (v === undefined) continue;
      const value = String(v).trim();
      if (f.secret) {
        if (value === '' || value.startsWith(MASK)) continue; // unchanged secret
        secrets[f.key] = value;
      } else {
        config[f.key] = value;
      }
    }
    const configured = !!(input.provider ?? current.provider) || Object.values(config).some(Boolean) || Object.keys(secrets).length > 0;
    const data = {
      provider: input.provider ?? current.provider,
      isEnabled: input.isEnabled ?? current.isEnabled,
      config,
      secretsEnc: Object.keys(secrets).length ? this.crypto.encrypt(JSON.stringify(secrets)) : null,
      status: configured ? 'configured' : 'not_configured',
    };
    const row = await this.prisma.integration.upsert({ where: { kind }, create: { kind, ...data }, update: data });
    return this.view(kind, row);
  }

  async test(kind: IntegrationKind): Promise<IntegrationView> {
    const i = await this.get(kind);
    let okFlag = true;
    let message = 'Settings saved. This integration is checked when it is first used.';
    try {
      message = (await this.runTest(i)) ?? message;
    } catch (err) {
      okFlag = false;
      message = (err as Error).message.slice(0, 300);
    }
    const row = await this.prisma.integration.upsert({
      where: { kind },
      create: { kind, status: okFlag ? 'ok' : 'failed', lastTestedAt: new Date(), lastTestMessage: message },
      update: { status: okFlag ? 'ok' : 'failed', lastTestedAt: new Date(), lastTestMessage: message },
    });
    return this.view(kind, row);
  }

  private async runTest(i: ResolvedIntegration): Promise<string | undefined> {
    const need = (v: string | undefined, label: string) => {
      if (!v) throw new Error(`${label} is missing`);
      return v;
    };
    switch (i.kind) {
      case 'whatsapp': {
        const base = i.config.apiBaseUrl || 'https://graph.facebook.com/v21.0';
        const res = await fetch(`${base}/${need(i.config.phoneNumberId, 'Phone number ID')}?fields=display_phone_number,verified_name`, {
          headers: { authorization: `Bearer ${need(i.secrets.accessToken, 'Access token')}` },
          signal: AbortSignal.timeout(20_000),
        });
        const json: any = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error?.message ?? `WhatsApp returned ${res.status}`);
        return `Connected to ${json?.verified_name ?? 'WhatsApp'} (${json?.display_phone_number ?? ''})`;
      }
      case 'sms': {
        if (i.provider === 'Twilio') {
          const sid = need(i.config.accountSid, 'Account SID');
          const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
            headers: { authorization: `Basic ${Buffer.from(`${sid}:${need(i.secrets.apiKey, 'Auth token')}`).toString('base64')}` },
            signal: AbortSignal.timeout(20_000),
          });
          if (!res.ok) throw new Error(`Twilio returned ${res.status}`);
          return 'Connected to Twilio';
        }
        if (i.provider === 'MSG91' || !i.provider) {
          const res = await fetch(`https://control.msg91.com/api/balance.php?authkey=${encodeURIComponent(need(i.secrets.apiKey, 'Auth key'))}&type=4`, { signal: AbortSignal.timeout(20_000) });
          const text = await res.text();
          if (!res.ok || /error|invalid/i.test(text)) throw new Error(`MSG91: ${text.slice(0, 120)}`);
          return `Connected to MSG91 (balance ${text.trim()})`;
        }
        need(i.secrets.apiKey, 'API key');
        return undefined;
      }
      case 'email': {
        const nodemailer = await import('nodemailer');
        const transport = nodemailer.createTransport({
          host: need(i.config.host, 'SMTP host'),
          port: Number(i.config.port || 587),
          secure: Number(i.config.port) === 465,
          auth: i.config.user ? { user: i.config.user, pass: i.secrets.password } : undefined,
        });
        await transport.verify();
        return 'SMTP server accepted the credentials';
      }
      case 'payment': {
        if (i.provider && i.provider !== 'Razorpay') return undefined;
        const keyId = need(i.config.keyId, 'Key ID');
        const auth = Buffer.from(`${keyId}:${need(i.secrets.keySecret, 'Key secret')}`).toString('base64');
        const res = await fetch('https://api.razorpay.com/v1/payments?count=1', { headers: { authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`Razorpay returned ${res.status}`);
        return `Connected to Razorpay (${keyId.startsWith('rzp_test') ? 'test mode' : 'live mode'})`;
      }
      case 'storage': {
        if (!i.provider || i.provider === 'Local disk') {
          const dir = workspaceUploadDir();
          await mkdir(dir, { recursive: true });
          const probe = path.join(dir, '.write-test');
          await writeFile(probe, 'ok');
          await unlink(probe);
          return `Files are stored in ${dir}`;
        }
        // Amazon S3 / Cloudflare R2: write, read back and delete a probe object.
        const cfg = s3ConfigFrom({ ...i, isEnabled: true });
        if (!cfg) return undefined;
        need(cfg.bucket, 'Bucket');
        need(cfg.accessKeyId, 'Access key ID');
        need(cfg.secretAccessKey, 'Secret access key');
        if (i.provider === 'Cloudflare R2') need(cfg.endpoint, 'Endpoint');
        const probe = `holysai-connection-test/${Date.now()}.txt`;
        await s3Put(cfg, probe, Buffer.from('ok'), 'text/plain');
        const back = await s3Get(cfg, probe);
        if (!back || (await back.text()) !== 'ok') throw new Error('The test file could not be read back');
        await s3Delete(cfg, probe);
        return `Connected to ${i.provider} bucket "${cfg.bucket}" (write, read and delete succeeded)`;
      }
      default:
        return undefined;
    }
  }

  private view(kind: IntegrationKind, row: Integration | null): IntegrationView {
    const def = INTEGRATION_KINDS.find((k) => k.id === kind)!;
    const config: Record<string, string> = { ...((row?.config as Record<string, string>) ?? {}) };
    if (row?.secretsEnc) {
      const secrets = JSON.parse(this.crypto.decrypt(row.secretsEnc)) as Record<string, string>;
      for (const [k, v] of Object.entries(secrets)) config[k] = `${MASK}${v.slice(-4)}`;
    }
    return {
      kind,
      label: def.label,
      providers: def.providers,
      provider: row?.provider ?? null,
      isEnabled: row?.isEnabled ?? false,
      config,
      status: (row?.status as IntegrationView['status']) ?? 'not_configured',
      lastTestedAt: row?.lastTestedAt?.toISOString() ?? null,
      lastTestMessage: row?.lastTestMessage ?? null,
    };
  }
}
