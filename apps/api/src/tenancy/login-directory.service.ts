import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { fieldError } from '../common/errors';
import { PlatformDb } from './platform-db.service';
import { TenancyService } from './tenancy.service';

export type LoginTarget = { kind: 'platform'; adminId: string } | { kind: 'school'; workspaceId: string; userId: string | null };

/** Lower-case email. */
export const normaliseEmail = (email: string) => email.trim().toLowerCase();
/** A mobile number's digits (spaces, +, dashes dropped); null when too short to be one. */
export const normalisePhone = (phone: string | null | undefined) => {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 6 ? digits : null;
};

/** What the person typed into "Email or mobile number", as a directory key. */
export function identifierKey(raw: string): { kind: 'email' | 'phone'; value: string } | null {
  const v = raw.trim();
  if (v.includes('@')) return { kind: 'email', value: normaliseEmail(v) };
  const phone = normalisePhone(v);
  return phone ? { kind: 'phone', value: phone } : null;
}

const UNIQUE_VIOLATION = '23505';

/**
 * The sign-in directory: one page for everyone, so each email / mobile number belongs to one school user or one
 * platform admin. School users' entries are written inside the school's own transaction (same database,
 * "platform" schema), so a user and their directory entry are saved or rolled back together.
 */
@Injectable()
export class LoginDirectory {
  private readonly log = new Logger('LoginDirectory');

  constructor(
    private readonly platform: PlatformDb,
    private readonly tenancy: TenancyService,
  ) {}

  /** Who signs in with this email or mobile number. */
  async lookup(identifier: string): Promise<LoginTarget | null> {
    const key = identifierKey(identifier);
    if (!key) return null;
    const row = await this.platform.loginIdentifier.findUnique({ where: { kind_value: key } });
    if (!row) return null;
    if (row.platformAdminId) return { kind: 'platform', adminId: row.platformAdminId };
    if (row.workspaceId) return { kind: 'school', workspaceId: row.workspaceId, userId: row.userId };
    return null;
  }

  /**
   * Field errors when the email or mobile number already signs in somewhere else (another school or We School
   * itself). Entries pointing at a user that no longer exists are removed on the way.
   */
  async assertAvailable(workspaceId: string, values: { email?: string | null; phone?: string | null }, userId?: string) {
    const checks: { field: 'email' | 'phone'; kind: 'email' | 'phone'; value: string | null }[] = [
      { field: 'email', kind: 'email', value: values.email ? normaliseEmail(values.email) : null },
      { field: 'phone', kind: 'phone', value: normalisePhone(values.phone) },
    ];
    for (const c of checks) {
      if (!c.value) continue;
      const row = await this.platform.loginIdentifier.findUnique({ where: { kind_value: { kind: c.kind, value: c.value } } });
      if (!row) continue;
      if (row.workspaceId === workspaceId && (!userId || row.userId === userId)) {
        if (!userId && row.userId && !(await this.userExists(workspaceId, row.userId))) {
          await this.platform.loginIdentifier.delete({ where: { id: row.id } }).catch(() => undefined);
        }
        continue;
      }
      if (row.workspaceId && row.userId && !(await this.userExists(row.workspaceId, row.userId))) {
        await this.platform.loginIdentifier.delete({ where: { id: row.id } }).catch(() => undefined);
        continue;
      }
      throw fieldError(c.field, c.kind === 'email' ? 'This email already signs in to another school on We School' : 'This mobile number already signs in to another school on We School');
    }
  }

  /** Saves a school user's directory entries inside the school transaction. */
  async writeForUser(tx: Prisma.TransactionClient, workspaceId: string, user: { id: string; email: string; phone: string | null }) {
    await tx.$executeRaw`DELETE FROM "platform"."LoginIdentifier" WHERE "workspaceId" = ${workspaceId}::uuid AND "userId" = ${user.id}::uuid`;
    const entries: { field: 'email' | 'phone'; value: string }[] = [{ field: 'email', value: normaliseEmail(user.email) }];
    const phone = normalisePhone(user.phone);
    if (phone) entries.push({ field: 'phone', value: phone });
    for (const e of entries) {
      try {
        await tx.$executeRaw`INSERT INTO "platform"."LoginIdentifier" ("id", "kind", "value", "workspaceId", "userId", "createdAt")
          VALUES (gen_random_uuid(), ${e.field}, ${e.value}, ${workspaceId}::uuid, ${user.id}::uuid, (now() AT TIME ZONE 'UTC'))`;
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw fieldError(e.field, e.field === 'email' ? 'This email already signs in to another school on We School' : 'This mobile number already signs in to another school on We School');
        }
        throw err;
      }
    }
  }

  /** Removes a school user's entries (inside the school transaction). */
  async removeForUser(tx: Prisma.TransactionClient, workspaceId: string, userId: string) {
    await tx.$executeRaw`DELETE FROM "platform"."LoginIdentifier" WHERE "workspaceId" = ${workspaceId}::uuid AND "userId" = ${userId}::uuid`;
  }

  /** Saves a platform admin's entries. */
  async writeForPlatformAdmin(admin: { id: string; email: string; phone: string | null }) {
    await this.platform.$transaction(async (tx) => {
      await tx.loginIdentifier.deleteMany({ where: { platformAdminId: admin.id } });
      await tx.loginIdentifier.create({ data: { kind: 'email', value: normaliseEmail(admin.email), platformAdminId: admin.id } });
      const phone = normalisePhone(admin.phone);
      if (phone) await tx.loginIdentifier.create({ data: { kind: 'phone', value: phone, platformAdminId: admin.id } });
    });
  }

  /**
   * Rebuilds one school's entries from its users (start-up check and nightly): adds missing entries, removes
   * entries of users that are gone, and reports emails / numbers another school already holds.
   */
  async reconcileWorkspace(workspaceId: string, users: { id: string; email: string; phone: string | null }[], skipUserIds: string[] = []) {
    const want = new Map<string, { kind: string; value: string; userId: string }>();
    for (const u of users) {
      if (skipUserIds.includes(u.id)) continue;
      want.set(`email:${normaliseEmail(u.email)}`, { kind: 'email', value: normaliseEmail(u.email), userId: u.id });
      const phone = normalisePhone(u.phone);
      if (phone) want.set(`phone:${phone}`, { kind: 'phone', value: phone, userId: u.id });
    }
    const have = await this.platform.loginIdentifier.findMany({ where: { workspaceId } });
    const haveKeys = new Map(have.map((r) => [`${r.kind}:${r.value}`, r]));
    const stale = have.filter((r) => !want.has(`${r.kind}:${r.value}`) || want.get(`${r.kind}:${r.value}`)!.userId !== r.userId);
    if (stale.length) await this.platform.loginIdentifier.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
    let added = 0;
    const conflicts: string[] = [];
    for (const [key, w] of want) {
      const existing = haveKeys.get(key);
      if (existing && existing.userId === w.userId) continue;
      try {
        await this.platform.loginIdentifier.create({ data: { kind: w.kind, value: w.value, workspaceId, userId: w.userId } });
        added++;
      } catch {
        conflicts.push(`${w.kind} ${w.value}`);
      }
    }
    if (conflicts.length) this.log.warn(`School ${workspaceId}: ${conflicts.length} sign-in name(s) are used by another school: ${conflicts.join(', ')}`);
    return { added, removed: stale.length, conflicts };
  }

  private async userExists(workspaceId: string, userId: string): Promise<boolean> {
    const ws = await this.tenancy.byId(workspaceId);
    if (!ws) return false;
    const n = await this.tenancy.client(ws).user.count({ where: { id: userId } });
    return n > 0;
  }

  private isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    return e?.meta?.code === UNIQUE_VIOLATION || e?.code === UNIQUE_VIOLATION || /23505|unique constraint/i.test(e?.message ?? '');
  }
}
