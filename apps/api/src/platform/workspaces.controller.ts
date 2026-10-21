import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { Public } from '../common/decorators';
import { ok, paged } from '../common/envelope';
import { badRequest, fieldError, notFound } from '../common/errors';
import { ListQuery, pageOf } from '../common/paging';
import { LoginDirectory, normaliseEmail } from '../tenancy/login-directory.service';
import { PlatformDb } from '../tenancy/platform-db.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { PlatformAudit } from './platform-audit.service';
import { CurrentAdmin, PlatformGuard, type PlatformAdminUser } from './platform.guard';
import { ProvisioningService, SUPPORT_EMAIL_DOMAIN, temporaryPassword } from './provisioning.service';
import { SupportService } from './support.service';
import { BillingService } from './billing/billing.service';
import { SubscriptionStatusService } from '../tenancy/subscription-status.service';

class FirstAdminDto {
  @IsString() @MinLength(2) @MaxLength(120) fullName: string;
  @IsEmail({}, { message: 'Enter a valid email' }) @MaxLength(200) email: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
}

class FirstSubscriptionDto {
  @IsString() planCode: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) startsOn?: string;
  @IsOptional() @IsInt() @Min(1) @Max(366) trialDays?: number;
  /** A payment already received for the first period (records it, which starts the period and makes an invoice). */
  @IsOptional() @IsNumber() @Min(0.01) amount?: number;
  @IsOptional() @IsIn(['bank', 'upi', 'cheque', 'cash', 'card', 'other']) method?: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
}

class CreateWorkspaceDto {
  @IsString() @MinLength(2) @MaxLength(160) name: string;
  @IsString() @MaxLength(30) code: string;
  @IsIn(['INR', 'USD']) currency: 'INR' | 'USD';
  @IsOptional() @IsString() @MaxLength(80) country?: string;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsOptional() @IsEmail({}, { message: 'Enter a valid email' }) contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(30) contactPhone?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(40) taxId?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ValidateNested() @Type(() => FirstAdminDto) admin: FirstAdminDto;
  @IsOptional() @ValidateNested() @Type(() => FirstSubscriptionDto) subscription?: FirstSubscriptionDto;
}

class UpdateWorkspaceDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(80) country?: string;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsOptional() @IsString() @MaxLength(200) contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(30) contactPhone?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(40) taxId?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

class SuspendDto {
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

class DeleteWorkspaceDto {
  /** The school code, typed by the admin to confirm. */
  @IsString() @MaxLength(40) code: string;
}

class SupportExchangeDto {
  @IsString() @MinLength(20) @MaxLength(100) code: string;
}

class AuditQuery extends ListQuery {
  @IsOptional() @IsString() workspaceId?: string;
}

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/** Schools on We School (platform admins only). */
@Public()
@UseGuards(PlatformGuard)
@Controller('platform')
export class WorkspacesController {
  constructor(
    private readonly platform: PlatformDb,
    private readonly tenancy: TenancyService,
    private readonly provisioning: ProvisioningService,
    private readonly support: SupportService,
    private readonly directory: LoginDirectory,
    private readonly audit: PlatformAudit,
    private readonly billing: BillingService,
    private readonly status: SubscriptionStatusService,
  ) {}

  @Get('overview')
  async overview() {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [rows, recent, paid] = await Promise.all([
      this.platform.workspace.findMany({ select: { id: true, name: true, code: true, status: true } }),
      this.platform.platformAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 8 }),
      this.platform.payment.groupBy({ by: ['currency'], where: { status: 'paid', paidAt: { gte: monthStart } }, _sum: { amount: true } }),
    ]);
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    const live = rows.filter((r) => ['active', 'suspended'].includes(r.status));
    const states = await Promise.all(live.map(async (w) => ({ w, s: await this.status.forWorkspace(w.id) })));
    const by = (st: string) => states.filter((x) => x.s.status === st).length;
    return {
      schools: { total: live.length, active: count('active'), suspended: count('suspended'), failed: count('failed') },
      subscriptions: { active: by('active'), expiring: by('expiring'), grace: by('grace'), expired: by('expired'), none: by('none') },
      revenueThisMonth: paid.map((p) => ({ currency: p.currency, amount: Number(p._sum.amount ?? 0) })),
      attention: states
        .filter((x) => ['expiring', 'grace', 'expired'].includes(x.s.status))
        .sort((a, b) => (a.s.daysLeft ?? 0) - (b.s.daysLeft ?? 0))
        .map((x) => ({ id: x.w.id, code: x.w.code, name: x.w.name, status: x.s.status, endsOn: x.s.endsOn, daysLeft: x.s.daysLeft })),
      recent: recent.map((a) => ({ id: a.id, at: a.createdAt.toISOString(), admin: a.adminName, action: a.action, description: a.description })),
    };
  }

  @Get('workspaces')
  async list() {
    const rows = await this.platform.workspace.findMany({ where: { status: { not: 'deleted' } }, orderBy: { createdAt: 'desc' } });
    const subs = await Promise.all(rows.map((w) => (['active', 'suspended'].includes(w.status) ? this.status.forWorkspace(w.id) : Promise.resolve(null))));
    return rows.map((w, i) => ({
      id: w.id, code: w.code, name: w.name, status: w.status, currency: w.currency, country: w.country,
      contactName: w.contactName, contactEmail: w.contactEmail, contactPhone: w.contactPhone, createdAt: w.createdAt.toISOString(),
      subscription: subs[i] ? { status: subs[i]!.status, endsOn: subs[i]!.endsOn, daysLeft: subs[i]!.daysLeft, planCode: subs[i]!.planCode } : null,
    }));
  }

  @Get('workspaces/:id')
  async get(@Param('id') id: string) {
    const w = await this.find(id);
    let usage: { campuses: number; students: number; staff: number; users: number } | null = null;
    let admins: { id: string; fullName: string; email: string; phone: string | null; status: string; lastLoginAt: string | null; mustChangePassword: boolean }[] = [];
    const ws = await this.tenancy.byId(w.id);
    if (ws) {
      const db = this.tenancy.client(ws);
      const notSupport = { NOT: { email: { endsWith: `.${SUPPORT_EMAIL_DOMAIN}` } } };
      const [campuses, students, staff, users, adminRows] = await Promise.all([
        db.campus.count({ where: { isActive: true } }),
        db.student.count({ where: { status: 'active' } }),
        db.employee.count({ where: { archivedAt: null } }),
        db.user.count({ where: notSupport }),
        db.user.findMany({ where: { ...notSupport, role: { key: 'super_admin' } }, orderBy: { createdAt: 'asc' } }),
      ]);
      usage = { campuses, students, staff, users };
      admins = adminRows.map((u) => ({ id: u.id, fullName: u.fullName, email: u.email, phone: u.phone, status: u.status, lastLoginAt: iso(u.lastLoginAt), mustChangePassword: u.mustChangePassword }));
    }
    return {
      id: w.id, code: w.code, name: w.name, status: w.status, currency: w.currency, country: w.country, timezone: w.timezone,
      contactName: w.contactName, contactEmail: w.contactEmail, contactPhone: w.contactPhone, address: w.address, taxId: w.taxId, notes: w.notes,
      schemaVersion: w.schemaVersion, suspendedAt: iso(w.suspendedAt), suspendReason: w.suspendReason, createdAt: w.createdAt.toISOString(),
      addresses: { api: `/api/w/${w.code}` },
      usage,
      admins,
    };
  }

  @Post('workspaces')
  async create(@Body() dto: CreateWorkspaceDto, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    const result = await this.provisioning.create(dto, admin, req);
    const s = dto.subscription;
    if (s) {
      if (s.amount) await this.billing.recordManual(result.workspace.id, { planCode: s.planCode, amount: s.amount, method: s.method ?? 'bank', reference: s.reference, paidOn: s.startsOn }, admin, req);
      else await this.billing.start(result.workspace.id, { planCode: s.planCode, startsOn: s.startsOn, trialDays: s.trialDays }, admin, req);
    }
    return ok(
      { workspace: { id: result.workspace.id, code: result.workspace.code, name: result.workspace.name, status: result.workspace.status }, admin: result.admin },
      `${result.workspace.name} is ready`,
    );
  }

  @Patch('workspaces/:id')
  async update(@Param('id') id: string, @Body() dto: UpdateWorkspaceDto, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    const w = await this.find(id);
    const text = (v: string | undefined) => (v === undefined ? undefined : v.trim() || null);
    const data = {
      name: dto.name?.trim() || undefined,
      country: dto.country?.trim() || undefined,
      timezone: dto.timezone?.trim() || undefined,
      contactName: text(dto.contactName),
      contactEmail: dto.contactEmail === undefined ? undefined : dto.contactEmail.trim() ? normaliseEmail(dto.contactEmail) : null,
      contactPhone: text(dto.contactPhone),
      address: text(dto.address),
      taxId: text(dto.taxId),
      notes: text(dto.notes),
    };
    const updated = await this.platform.workspace.update({ where: { id: w.id }, data });
    // The school's own name setting follows a rename (shown in the school's header, receipts and certificates).
    if (data.name && data.name !== w.name) {
      const ws = await this.tenancy.byId(w.id);
      if (ws) await this.tenancy.client(ws).setting.updateMany({ where: { key: 'school.name' }, data: { value: data.name } });
    }
    this.tenancy.refreshList();
    await this.audit.record({ admin, action: 'update', entityType: 'workspace', entityId: w.id, workspaceId: w.id, description: `Updated ${updated.name}`, req });
    return ok({ id: updated.id }, 'School updated');
  }

  @Post('workspaces/:id/suspend')
  @HttpCode(200)
  async suspend(@Param('id') id: string, @Body() dto: SuspendDto, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    const w = await this.find(id);
    if (w.status !== 'active') throw badRequest('Only an active school can be suspended');
    await this.platform.workspace.update({ where: { id: w.id }, data: { status: 'suspended', suspendedAt: new Date(), suspendReason: dto.reason.trim() } });
    this.tenancy.refreshList();
    this.status.invalidate(w.id);
    await this.audit.record({ admin, action: 'suspend', entityType: 'workspace', entityId: w.id, workspaceId: w.id, description: `Suspended ${w.name}: ${dto.reason.trim()}`, req });
    return ok({ id: w.id, status: 'suspended' }, `${w.name} is suspended — its users cannot sign in`);
  }

  @Post('workspaces/:id/resume')
  @HttpCode(200)
  async resume(@Param('id') id: string, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    const w = await this.find(id);
    if (w.status !== 'suspended') throw badRequest('This school is not suspended');
    await this.platform.workspace.update({ where: { id: w.id }, data: { status: 'active', suspendedAt: null, suspendReason: null } });
    this.tenancy.refreshList();
    this.status.invalidate(w.id);
    await this.audit.record({ admin, action: 'resume', entityType: 'workspace', entityId: w.id, workspaceId: w.id, description: `Resumed ${w.name}`, req });
    return ok({ id: w.id, status: 'active' }, `${w.name} is active again`);
  }

  /** Deletes a suspended school (or a failed set-up) and all its data; payments and invoices are kept. */
  @Post('workspaces/:id/delete')
  @HttpCode(200)
  async remove(@Param('id') id: string, @Body() dto: DeleteWorkspaceDto, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    const w = await this.find(id);
    const done = await this.provisioning.remove(w.id, dto.code, admin, req);
    this.status.invalidate(w.id);
    return ok(done, `${done.name} was deleted`);
  }

  /** Support access: a single-use code the console opens in a new tab (/support#code=…). */
  @Post('workspaces/:id/support')
  @HttpCode(200)
  async supportCode(@Param('id') id: string, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    const w = await this.find(id);
    return this.support.createCode(w.id, admin, req);
  }

  /** Adds another Workspace Admin to a school (e.g. when the school lost its admin's access). */
  @Post('workspaces/:id/admins')
  async addAdmin(@Param('id') id: string, @Body() dto: FirstAdminDto, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    const w = await this.find(id);
    const ws = await this.tenancy.byId(w.id);
    if (!ws) throw badRequest('This school is not active');
    const email = normaliseEmail(dto.email);
    await this.directory.assertAvailable(w.id, { email, phone: dto.phone });
    const password = temporaryPassword();
    const userId = await this.tenancy.run(ws, async () => {
      const db = this.tenancy.current();
      if (await db.user.findUnique({ where: { email } })) throw fieldError('email', 'This school already has an account with this email');
      return this.provisioning.addAdmin(db, w.id, { fullName: dto.fullName, email, phone: dto.phone }, password);
    });
    await this.audit.record({ admin, action: 'create', entityType: 'user', entityId: userId, workspaceId: w.id, description: `Added Workspace Admin ${email} to ${w.name}`, req });
    return ok({ id: userId, email, temporaryPassword: password }, 'Workspace Admin added');
  }

  /** A new temporary password for one of the school's admins (unlocks the account and signs it out everywhere). */
  @Post('workspaces/:id/admins/:userId/reset-password')
  @HttpCode(200)
  async resetAdmin(@Param('id') id: string, @Param('userId') userId: string, @CurrentAdmin() admin: PlatformAdminUser, @Req() req: Request) {
    const w = await this.find(id);
    const ws = await this.tenancy.byId(w.id);
    if (!ws) throw badRequest('This school is not active');
    const password = temporaryPassword();
    const target = await this.tenancy.run(ws, async () => {
      const db = this.tenancy.current();
      const u = await db.user.findFirst({ where: { id: userId, role: { key: 'super_admin' }, NOT: { email: { endsWith: `.${SUPPORT_EMAIL_DOMAIN}` } } } });
      if (!u) throw notFound('Workspace Admin');
      await db.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(password, 12), mustChangePassword: true, failedLogins: 0, lockedUntil: null, status: 'active' } });
      await db.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await db.auditLog.create({
        data: { userName: 'We School', action: 'update', module: 'users', entityType: 'user', entityId: u.id, description: `We School (${admin.fullName}) reset the password of ${u.fullName}`, device: 'system', sensitive: true },
      });
      return u;
    });
    await this.audit.record({ admin, action: 'update', entityType: 'user', entityId: target.id, workspaceId: w.id, description: `Reset the password of ${target.email} in ${w.name}`, req });
    return ok({ id: target.id, email: target.email, temporaryPassword: password }, 'New temporary password created');
  }

  @Get('audit')
  async auditLog(@Query() q: AuditQuery) {
    const p = pageOf(q);
    const where = q.workspaceId ? { workspaceId: q.workspaceId } : {};
    const [rows, total] = await Promise.all([
      this.platform.platformAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
      this.platform.platformAuditLog.count({ where }),
    ]);
    const names = new Map((await this.platform.workspace.findMany({ select: { id: true, name: true } })).map((w) => [w.id, w.name]));
    return paged(
      rows.map((a) => ({ id: a.id, at: a.createdAt.toISOString(), admin: a.adminName, action: a.action, description: a.description, school: a.workspaceId ? names.get(a.workspaceId) ?? null : null, ip: a.ip })),
      total,
      p,
    );
  }

  private async find(id: string) {
    const w = await this.platform.workspace.findFirst({ where: { status: { not: 'deleted' }, OR: [{ code: id }, ...(/^[0-9a-f-]{36}$/i.test(id) ? [{ id }] : [])] } });
    if (!w) throw notFound('School');
    return w;
  }
}

/** The new support tab exchanges its single-use code for a one-hour session in the school. */
@Public()
@Controller('platform/support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('exchange')
  @HttpCode(200)
  exchange(@Body() dto: SupportExchangeDto, @Req() req: Request) {
    return this.support.exchange(dto.code, req);
  }
}
