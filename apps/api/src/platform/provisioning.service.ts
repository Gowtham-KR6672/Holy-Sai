import { Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import { conflict, fieldError } from '../common/errors';
import type { WorkspaceRef } from '../tenancy/context';
import { LoginDirectory, normaliseEmail } from '../tenancy/login-directory.service';
import { migrateSchoolSchema } from '../tenancy/migrator';
import { PlatformDb } from '../tenancy/platform-db.service';
import { seedSchoolCatalog } from '../tenancy/school-seed';
import { TenancyService } from '../tenancy/tenancy.service';
import { WorkspaceSeeds } from '../tenancy/workspace-seeds.service';
import { PlatformAudit } from './platform-audit.service';
import type { PlatformAdminUser } from './platform.guard';

/** The hidden support account in every school uses an address on this (reserved, undeliverable) domain. */
export const SUPPORT_EMAIL_DOMAIN = 'support.weschool.invalid';
export const supportEmail = (code: string) => `we-school-support@${code}.${SUPPORT_EMAIL_DOMAIN}`;
export const isSupportEmail = (email: string | null | undefined) => !!email && email.endsWith(`.${SUPPORT_EMAIL_DOMAIN}`);

/** Codes that would clash with addresses or schemas. */
const RESERVED_CODES = new Set(['platform', 'public', 'api', 'www', 'admin', 'support', 'default', 'test', 'app', 'w']);
export const WORKSPACE_CODE = /^[a-z][a-z0-9]{1,29}$/;

/** A temporary password that meets the school password rule (10+ characters, upper, lower, digit). */
export function temporaryPassword(): string {
  const pick = (chars: string, n: number) => Array.from({ length: n }, () => chars[randomInt(chars.length)]).join('');
  const parts = [pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 3), pick('abcdefghijkmnpqrstuvwxyz', 5), pick('23456789', 3), pick('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', 3)];
  return parts.join('').split('').sort(() => randomInt(3) - 1).join('');
}

export interface NewWorkspaceInput {
  name: string;
  code: string;
  currency: 'INR' | 'USD';
  country?: string;
  timezone?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  taxId?: string;
  notes?: string;
  admin: { fullName: string; email: string; phone?: string };
}

/**
 * Creates a school: its schema (all school tables, via the school migrations), the system catalogue, the hidden
 * support account and the first Workspace Admin with a temporary password. A failed attempt can be retried with
 * the same code; every step is idempotent.
 */
@Injectable()
export class ProvisioningService {
  private readonly log = new Logger('Provisioning');

  constructor(
    private readonly platform: PlatformDb,
    private readonly tenancy: TenancyService,
    private readonly directory: LoginDirectory,
    private readonly seeds: WorkspaceSeeds,
    private readonly audit: PlatformAudit,
  ) {}

  async create(input: NewWorkspaceInput, actor: PlatformAdminUser | null, req?: Request) {
    const code = input.code.trim().toLowerCase();
    if (!WORKSPACE_CODE.test(code)) throw fieldError('code', '2–30 lower-case letters or digits, starting with a letter');
    if (RESERVED_CODES.has(code)) throw fieldError('code', 'This code is reserved — choose another');
    const name = input.name.trim();
    if (!name) throw fieldError('name', 'Enter the school name');
    const adminEmail = normaliseEmail(input.admin.email);

    const existing = await this.platform.workspace.findUnique({ where: { code } });
    if (existing && existing.status !== 'failed') throw fieldError('code', 'Another school already uses this code');
    // The admin's email / mobile must not sign in anywhere else yet (a failed attempt's own entries are fine).
    await this.directory.assertAvailable(existing?.id ?? '00000000-0000-0000-0000-000000000000', { email: adminEmail, phone: input.admin.phone });

    const data = {
      name,
      currency: input.currency,
      country: input.country?.trim() || 'India',
      timezone: input.timezone?.trim() || 'Asia/Kolkata',
      contactName: input.contactName?.trim() || null,
      contactEmail: input.contactEmail ? normaliseEmail(input.contactEmail) : null,
      contactPhone: input.contactPhone?.trim() || null,
      address: input.address?.trim() || null,
      taxId: input.taxId?.trim() || null,
      notes: input.notes?.trim() || null,
    };
    const row = existing
      ? await this.platform.workspace.update({ where: { id: existing.id }, data: { ...data, status: 'provisioning' } })
      : await this.platform.workspace.create({ data: { ...data, code, schemaName: `ws_${code}`, status: 'provisioning', createdById: actor?.id ?? null } });

    try {
      const { version } = await migrateSchoolSchema(row.schemaName, (m) => this.log.log(m));
      const ref: WorkspaceRef = { id: row.id, code, name, schema: row.schemaName, status: 'active' };
      const password = temporaryPassword();
      const { supportUserId, adminUserId } = await this.tenancy.run(ref, async () => {
        const db = this.tenancy.current();
        await seedSchoolCatalog(db, { 'school.name': name, 'school.timezone': data.timezone });
        await this.seeds.runAll();
        const supportUserId = await this.ensureSupportUser(db, code);
        const adminUserId = await this.addAdmin(db, row.id, { ...input.admin, email: adminEmail }, password);
        await db.auditLog.create({
          data: { userName: 'We School', action: 'create', module: 'system', entityType: 'workspace', entityId: row.id, description: `School created on We School${actor ? ` by ${actor.fullName}` : ''}`, device: 'system' },
        });
        return { supportUserId, adminUserId };
      });
      const ws = await this.platform.workspace.update({ where: { id: row.id }, data: { status: 'active', schemaVersion: version, supportUserId } });
      this.tenancy.refreshList();
      await this.audit.record({
        admin: actor, action: 'create', entityType: 'workspace', entityId: ws.id, workspaceId: ws.id,
        description: `Created school ${ws.name} (${ws.code}) with admin ${adminEmail}`, req,
      });
      return { workspace: ws, admin: { id: adminUserId, email: adminEmail, temporaryPassword: password } };
    } catch (err) {
      await this.platform.workspace.update({ where: { id: row.id }, data: { status: 'failed', notes: `Setup failed: ${(err as Error).message}`.slice(0, 1000) } }).catch(() => undefined);
      this.log.error(`Creating school ${code} failed: ${(err as Error).message}`);
      if ((err as { status?: number }).status) throw err;
      throw conflict(`The school could not be set up: ${(err as Error).message.split('\n')[0]}. Fix the cause and create it again with the same code.`);
    }
  }

  /** The hidden "We School Support" account used when a platform admin enters the school. */
  async ensureSupportUser(db: PrismaClient, code: string): Promise<string> {
    const email = supportEmail(code);
    const found = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (found) return found.id;
    const role = await db.role.findUniqueOrThrow({ where: { key: 'super_admin' } });
    const user = await db.user.create({
      data: {
        fullName: 'We School Support',
        email,
        title: 'We School support',
        roleId: role.id,
        // No usable password: support sessions are opened from the platform console only.
        passwordHash: await bcrypt.hash(randomBytes(32).toString('base64url'), 10),
        mustChangePassword: false,
      },
    });
    return user.id;
  }

  /** The school's first Workspace Admin (all campuses), with a temporary password to change at first sign-in. */
  async addAdmin(db: PrismaClient, workspaceId: string, admin: { fullName: string; email: string; phone?: string }, password: string): Promise<string> {
    const role = await db.role.findUniqueOrThrow({ where: { key: 'super_admin' } });
    const hash = await bcrypt.hash(password, 12);
    return db.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email: admin.email } });
      const phone = admin.phone?.trim() || null;
      const user = existing
        ? await tx.user.update({ where: { id: existing.id }, data: { passwordHash: hash, mustChangePassword: true, status: 'active', phone } })
        : await tx.user.create({
            data: { fullName: admin.fullName.trim(), email: admin.email, phone, title: 'Workspace Admin', roleId: role.id, passwordHash: hash, mustChangePassword: true },
          });
      await this.directory.writeForUser(tx, workspaceId, user);
      return user.id;
    });
  }
}
