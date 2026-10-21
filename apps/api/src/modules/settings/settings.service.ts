import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { badRequest, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { PerWorkspace } from '../../tenancy/context';

const kindOf = (v: unknown) => (typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : typeof v === 'string' ? 'string' : 'json');

/** Typed access to the key/value system settings (cached for 30 seconds, per school). */
@Injectable()
export class SettingsService {
  private readonly state = new PerWorkspace(() => ({ values: new Map<string, unknown>(), loadedAt: 0 }));

  constructor(private readonly prisma: PrismaService) {}

  private async load() {
    const st = this.state.get();
    if (Date.now() - st.loadedAt < 30_000) return st.values;
    const rows = await this.prisma.setting.findMany();
    st.values = new Map(rows.map((r) => [r.key, r.value]));
    st.loadedAt = Date.now();
    return st.values;
  }

  async get<T>(key: string, fallback: T): Promise<T> {
    const values = await this.load();
    return values.has(key) ? (values.get(key) as T) : fallback;
  }

  async publicValues(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.setting.findMany({ where: { isPublic: true } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Updates a setting; the new value must keep the same kind (number, text, on/off or list/object). */
  async update(key: string, value: unknown, userId: string) {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    if (!row) throw notFound('Setting');
    const want = kindOf(row.value);
    if (kindOf(value) !== want) throw badRequest(`This setting needs ${want === 'json' ? 'a list or object' : `a ${want}`} value`);
    if (want === 'number' && !Number.isFinite(value as number)) throw badRequest('Enter a number');
    if (want === 'string' && !(value as string).trim()) throw badRequest('Enter a value');
    const updated = await this.prisma.setting.update({
      where: { key },
      data: { value: (want === 'string' ? (value as string).trim() : value) as Prisma.InputJsonValue, updatedById: userId },
    });
    this.state.get().loadedAt = 0;
    return { before: row.value, after: updated };
  }
}
