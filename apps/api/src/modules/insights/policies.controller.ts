import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { GroupPolicy, Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, notFound } from '../../common/errors';
import { like, ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { dateOf, isoOrNull, keyOrNull, sortRows, uuidOr404 } from './insights.util';

export const POLICY_STATUSES = ['Draft', 'Under review', 'Active', 'Retired'];
const EDITABLE = ['Draft', 'Under review', 'Active'];
const VERSION_RE = /^v\d+(\.\d+){0,2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class PolicyQuery extends ListQuery {
  @IsOptional() @IsIn(POLICY_STATUSES) status?: string;
}

class PolicyDto {
  @IsString() @MinLength(2, { message: 'Enter the policy name' }) @MaxLength(160) name: string;
  @IsString() @MinLength(2, { message: 'Enter the scope' }) @MaxLength(80) scope: string;
  @Matches(VERSION_RE, { message: 'Use a version like v1.0' }) version: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(20000) body?: string | null;
  @IsIn(EDITABLE, { message: 'Choose Draft, Under review or Active' }) status: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Matches(DATE_RE, { message: 'Choose the effective date' }) effectiveOn?: string | null;
}

class PolicyUpdateDto extends PolicyDto {
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(300) changeNote?: string | null;
}

/** "v1.2" → [1, 2, 0] */
const parts = (v: string) => {
  const p = v.replace(/^v/i, '').split('.').map((x) => Number(x) || 0);
  while (p.length < 3) p.push(0);
  return p;
};
const compareVersions = (a: string, b: string) => {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** Policies that apply across the group, with versions and review status. Text or scope changes keep the old version. */
@Controller('group/policies')
export class PoliciesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  @RequirePermissions('group.read', 'group.manage')
  async list(@Query() q: PolicyQuery) {
    const p = pageOf(q);
    const term = q.q?.trim();
    const where: Prisma.GroupPolicyWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(term ? { OR: [{ name: like(term) }, { scope: like(term) }, { version: like(term) }] } : {}),
    };
    const list = await this.prisma.groupPolicy.findMany({
      where, orderBy: { name: 'asc' }, take: 5000,
      select: {
        id: true, name: true, scope: true, version: true, status: true, effectiveOn: true, updatedAt: true, updatedByName: true, createdByName: true,
        body: true, _count: { select: { versions: true } },
      },
    });
    const order = Object.fromEntries(POLICY_STATUSES.map((s, i) => [s, i]));
    const rows = list.map((x) => ({
      id: x.id, name: x.name, scope: x.scope, version: x.version, status: x.status, effectiveOn: keyOrNull(x.effectiveOn),
      updatedAt: x.updatedAt.toISOString(), updatedBy: x.updatedByName ?? x.createdByName, hasBody: !!x.body?.trim(), previousVersions: x._count.versions,
    }));
    const keys: Record<string, (r: (typeof rows)[number]) => string | number | null> = {
      name: (r) => r.name,
      version: (r) => parts(r.version).map((n) => String(n).padStart(4, '0')).join('.'),
      updated: (r) => r.updatedAt,
      status: (r) => order[r.status] ?? 9,
    };
    const key = q.sort && keys[q.sort] ? q.sort : 'name';
    const sorted = sortRows(rows, keys[key], q.dir ?? (key === 'updated' ? 'desc' : 'asc'));
    return paged(sorted.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  @Get(':id')
  @RequirePermissions('group.read', 'group.manage')
  async get(@Param('id') id: string) {
    uuidOr404(id, 'Policy');
    const p = await this.prisma.groupPolicy.findUnique({ where: { id }, include: { versions: { orderBy: { archivedAt: 'desc' } } } });
    if (!p) throw notFound('Policy');
    return this.detail(p);
  }

  @Post()
  @RequirePermissions('group.manage')
  async create(@Body() dto: PolicyDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const data = await this.validate(dto, null);
    const p = await this.prisma.groupPolicy.create({
      data: { ...data, createdById: user.id, createdByName: user.fullName, updatedById: user.id, updatedByName: user.fullName },
    });
    await this.audit.record({
      user, action: 'create', module: 'group', entityType: 'group_policy', entityId: p.id, req,
      description: `Added group policy “${p.name}” ${p.version} (${p.status})`,
    });
    if (p.status === 'Active') await this.announce(p);
    return ok({ id: p.id }, 'Policy created');
  }

  @Put(':id')
  @RequirePermissions('group.manage')
  async update(@Param('id') id: string, @Body() dto: PolicyUpdateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const before = await this.find(id);
    if (before.status === 'Retired') throw badRequest('Retired policies cannot be edited');
    const data = await this.validate(dto, before);
    const contentChanged = (data.body ?? '') !== (before.body ?? '') || data.scope !== before.scope;
    const newVersion = data.version !== before.version;
    if (contentChanged && !newVersion) throw fieldError('version', `Text changed — increase from ${before.version}`);
    if (newVersion && compareVersions(data.version, before.version) <= 0) throw fieldError('version', `Use a version above ${before.version}`);
    const note = dto.changeNote?.trim() || null;

    const after = await this.prisma.$transaction(async (tx) => {
      if (newVersion) {
        await tx.groupPolicyVersion.create({
          data: {
            policyId: before.id, version: before.version, status: before.status, scope: before.scope, body: before.body, effectiveOn: before.effectiveOn,
            changeNote: note, archivedById: user.id, archivedByName: user.fullName,
          },
        });
      }
      return tx.groupPolicy.update({ where: { id }, data: { ...data, updatedById: user.id, updatedByName: user.fullName } });
    });
    await this.audit.record({
      user, action: 'update', module: 'group', entityType: 'group_policy', entityId: id, req,
      description: newVersion
        ? `Published ${after.version} of group policy “${after.name}” (was ${before.version})${note ? ` — ${note}` : ''}`
        : `Updated group policy “${after.name}”${before.status !== after.status ? ` (${before.status} to ${after.status})` : ''}`,
      metadata: before.status !== after.status ? { from: before.status, to: after.status } : newVersion ? { from: before.version, to: after.version } : undefined,
    });
    if (after.status === 'Active' && (before.status !== 'Active' || newVersion)) await this.announce(after);
    return ok({ id }, newVersion ? `Policy updated to ${after.version}` : 'Policy updated');
  }

  @Delete(':id')
  @RequirePermissions('group.manage')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const p = await this.find(id);
    if (p.status === 'Retired') throw badRequest('This policy is already retired');
    if (p.status === 'Draft') {
      await this.prisma.groupPolicy.delete({ where: { id } });
      await this.audit.record({ user, action: 'delete', module: 'group', entityType: 'group_policy', entityId: id, req, description: `Deleted draft group policy “${p.name}”` });
      return ok({ result: 'deleted' }, 'Draft deleted');
    }
    await this.prisma.groupPolicy.update({ where: { id }, data: { status: 'Retired', retiredAt: new Date(), updatedById: user.id, updatedByName: user.fullName } });
    await this.audit.record({
      user, action: 'update', module: 'group', entityType: 'group_policy', entityId: id, req,
      description: `Retired group policy “${p.name}” ${p.version}`, metadata: { from: p.status, to: 'Retired' },
    });
    return ok({ result: 'retired' }, 'Policy retired');
  }

  // ---------------------------------------------------------------------------

  private async find(id: string) {
    uuidOr404(id, 'Policy');
    const p = await this.prisma.groupPolicy.findUnique({ where: { id } });
    if (!p) throw notFound('Policy');
    return p;
  }

  private detail(p: Prisma.GroupPolicyGetPayload<{ include: { versions: true } }>) {
    return {
      id: p.id, name: p.name, scope: p.scope, version: p.version, status: p.status, effectiveOn: keyOrNull(p.effectiveOn),
      updatedAt: p.updatedAt.toISOString(), updatedBy: p.updatedByName ?? p.createdByName, body: p.body, createdAt: p.createdAt.toISOString(),
      versions: p.versions.map((v) => ({
        id: v.id, version: v.version, status: v.status, effectiveOn: keyOrNull(v.effectiveOn), changeNote: v.changeNote,
        archivedAt: isoOrNull(v.archivedAt)!, archivedBy: v.archivedByName,
      })),
    };
  }

  private async validate(dto: PolicyDto, existing: GroupPolicy | null) {
    const name = dto.name.trim();
    const scope = dto.scope.trim();
    if (dto.status === 'Active' && !dto.effectiveOn) throw fieldError('effectiveOn', 'Effective date is required');
    const clash = await this.prisma.groupPolicy.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, status: { not: 'Retired' }, ...(existing ? { id: { not: existing.id } } : {}) },
      select: { id: true },
    });
    if (clash) throw fieldError('name', 'A policy with this name already exists');
    return {
      name,
      scope,
      version: dto.version,
      body: dto.body?.trim() ? dto.body : null,
      status: dto.status,
      effectiveOn: dto.effectiveOn ? dateOf(dto.effectiveOn) : null,
    };
  }

  /** Staff who read group policies hear when one takes effect. */
  private async announce(p: GroupPolicy) {
    await this.notifications
      .notifyPermission('group.read', {
        category: 'Information', topic: 'system', module: 'group', route: '/group-policies',
        title: `Group policy in force: ${p.name} ${p.version}`,
        body: p.effectiveOn ? `Effective from ${keyOrNull(p.effectiveOn)}.` : undefined,
      })
      .catch(() => undefined);
  }
}
