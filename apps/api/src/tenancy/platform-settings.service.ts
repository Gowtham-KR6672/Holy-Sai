import { Injectable } from '@nestjs/common';
import { CryptoService } from '../common/crypto.service';
import { PlatformDb, type PlatformPrisma } from './platform-db.service';

/** Platform-wide settings with their defaults. Secret values are stored encrypted (see SECRET_KEYS). */
export const PLATFORM_SETTING_DEFAULTS: Record<string, unknown> = {
  'subscription.warning_days': 15,
  'subscription.grace_days': 7,
  'billing.legal_name': 'We School',
  'billing.address': '',
  'billing.tax_id': '',
  'billing.tax_label': 'GST',
  'billing.tax_percent_inr': 0,
  'billing.tax_percent_usd': 0,
  'billing.invoice_prefix': 'WS-INV',
  'billing.support_email': '',
  'email.smtp_host': '',
  'email.smtp_port': 587,
  'email.smtp_user': '',
  'email.smtp_password': '',
  'email.from_address': '',
};

/** Settings whose values are encrypted at rest and never sent back to the browser. */
export const SECRET_KEYS = new Set(['email.smtp_password']);

/** We School's own settings (billing details, reminder and grace days, the email sender). Cached for 30 seconds. */
@Injectable()
export class PlatformSettings {
  private cache: { at: number; values: Map<string, unknown> } | null = null;

  constructor(
    private readonly platform: PlatformDb,
    private readonly crypto: CryptoService,
  ) {}

  private async load(): Promise<Map<string, unknown>> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.values;
    const rows = await this.platform.platformSetting.findMany();
    const values = new Map<string, unknown>(Object.entries(PLATFORM_SETTING_DEFAULTS));
    for (const r of rows) values.set(r.key, SECRET_KEYS.has(r.key) && typeof r.value === 'string' && r.value ? this.crypto.decrypt(r.value) : r.value);
    this.cache = { at: Date.now(), values };
    return values;
  }

  async get<T>(key: string): Promise<T> {
    return (await this.load()).get(key) as T;
  }

  /** Every setting for the console; secrets come back as "set" / "" only. */
  async all(): Promise<Record<string, unknown>> {
    const values = await this.load();
    return Object.fromEntries([...values].map(([k, v]) => [k, SECRET_KEYS.has(k) ? (v ? '••••••••' : '') : v]));
  }

  /** Saves changed values (unknown keys are ignored; a masked secret leaves the stored secret unchanged). */
  async update(changes: Record<string, unknown>, adminId: string) {
    for (const [key, raw] of Object.entries(changes)) {
      if (!(key in PLATFORM_SETTING_DEFAULTS)) continue;
      if (SECRET_KEYS.has(key) && raw === '••••••••') continue;
      const fallback = PLATFORM_SETTING_DEFAULTS[key];
      let value: unknown = raw;
      if (typeof fallback === 'number') value = Number(raw);
      if (typeof fallback === 'number' && !Number.isFinite(value as number)) continue;
      if (typeof fallback === 'string') value = String(raw ?? '').trim();
      const stored = SECRET_KEYS.has(key) && value ? this.crypto.encrypt(String(value)) : value;
      await this.platform.platformSetting.upsert({
        where: { key },
        create: { key, value: stored as PlatformPrisma.InputJsonValue, updatedById: adminId },
        update: { value: stored as PlatformPrisma.InputJsonValue, updatedById: adminId },
      });
    }
    this.cache = null;
  }
}
