import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PermissionCacheService } from '../../common/permission-cache.service';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PASSWORD_HINT, PASSWORD_RULE } from '../auth/auth.service';
import { TokensService } from '../auth/tokens.service';
import { type LinkedRecord, assertCanActivate, linkCandidates, linkKindFor, linkedRecords, resolveLink } from './account-links';

class UserQuery extends ListQuery {
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsString() status?: string;
}

class CreateUserDto {
  @IsString() @MinLength(2) @MaxLength(120) fullName: string;
  @IsEmail({}, { message: 'Enter a valid email address' }) email: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsString() roleKey: string;
  @IsOptional() @IsUUID() campusId?: string;
  @IsString() password: string;
  /** Student / parent / staff record this login belongs to (required for student and parent roles). */
  @IsOptional() @IsUUID() linkId?: string;
}

class UpdateUserDto {
  @IsOptional() @IsString() roleKey?: string;
  @IsOptional() @IsIn(['active', 'suspended', 'disabled']) status?: 'active' | 'suspended' | 'disabled';
  @IsOptional() @IsBoolean() unlock?: boolean;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) fullName?: string;
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @IsOptional() @IsUUID() campusId?: string;
  /** Link to a record (null or '' unlinks). */
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @IsUUID() linkId?: string | null;
}

class LinkQuery {
  @IsIn(['student', 'parent', 'employee']) kind: 'student' | 'parent' | 'employee';
  @IsOptional() @IsString() q?: string;
}

const userRow = (u: Prisma.UserGetPayload<{ include: { role: true } }>, linked: LinkedRecord | null = null) => ({
  id: u.id,
  email: u.email,
  phone: u.phone,
  fullName: u.fullName,
  title: u.title,
  status: u.status,
  role: u.role.key,
  roleName: u.role.name,
  campusId: u.campusId,
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  lockedUntil: u.lockedUntil?.toISOString() ?? null,
  linkKind: linkKindFor(u.role.key),
  linked,
});

@Controller('users')
@RequirePermissions('users.manage')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokensService,
    private readonly perms: PermissionCacheService,
  ) {}

  @Get()
  async list(@Query() q: UserQuery) {
    const p = pageOf(q);
    const where: Prisma.UserWhereInput = {
      ...(q.role ? { role: { key: q.role } } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ fullName: like(q.q) }, { email: like(q.q) }, { title: like(q.q) }, { phone: like(q.q) }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({ where, include: { role: true }, orderBy: { fullName: 'asc' }, skip: p.skip, take: p.take }),
      this.prisma.user.count({ where }),
    ]);
    const links = await linkedRecords(this.prisma, rows);
    return paged(rows.map((u) => userRow(u, links.get(u.id) ?? null)), total, p);
  }

  /** Records a new or existing account can be linked to (not yet linked to another account). */
  @Get('link-candidates')
  candidates(@Query() q: LinkQuery) {
    return linkCandidates(this.prisma, q.kind, q.q ?? '');
  }

  @Post()
  async create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthUser, @Req() req: Request) {
    const role = await this.prisma.role.findUnique({ where: { key: dto.roleKey } });
    if (!role) throw fieldError('roleKey', 'Choose a role');
    if (role.key === 'super_admin' && actor.roleKey !== 'super_admin') throw forbidden('Only a Super Admin can grant the Super Admin role');
    if (!PASSWORD_RULE.test(dto.password)) throw fieldError('password', PASSWORD_HINT);
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw fieldError('email', 'An account with this email already exists');
    const phone = dto.phone?.trim() || null;
    if (phone && (await this.prisma.user.findUnique({ where: { phone } }))) throw fieldError('phone', 'An account with this mobile number already exists');
    const link = await resolveLink(this.prisma, { kind: linkKindFor(role.key), linkId: dto.linkId, email, phone });
    const user = await this.prisma.user.create({
      data: {
        fullName: dto.fullName.trim(),
        email,
        phone,
        title: dto.title?.trim() || null,
        roleId: role.id,
        campusId: dto.campusId ?? link.campusId,
        studentId: link.studentId,
        parentId: link.parentId,
        employeeId: link.employeeId,
        passwordHash: await bcrypt.hash(dto.password, 12),
        mustChangePassword: true,
      },
      include: { role: true },
    });
    await this.audit.record({ user: actor, action: 'create', module: 'users', entityType: 'user', entityId: user.id, description: `Created ${role.name} account for ${user.fullName}${link.name ? ` (linked to ${link.name})` : ''}`, req });
    const links = await linkedRecords(this.prisma, [user]);
    return ok(userRow(user, links.get(user.id) ?? null), 'User created');
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthUser, @Req() req: Request) {
    const existing = await this.prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (!existing) throw notFound('User');
    const data: Prisma.UserUpdateInput = {};
    const notes: string[] = [];
    let signOut = false;

    if (dto.roleKey && dto.roleKey !== existing.role.key) {
      if (id === actor.id) throw forbidden('You cannot change your own role');
      const role = await this.prisma.role.findUnique({ where: { key: dto.roleKey } });
      if (!role) throw fieldError('roleKey', 'Unknown role');
      if ((role.key === 'super_admin' || existing.role.key === 'super_admin') && actor.roleKey !== 'super_admin') throw forbidden('Only a Super Admin can change Super Admin access');
      if (existing.role.key === 'super_admin') await this.keepOneSuperAdmin(id);
      data.role = { connect: { id: role.id } };
      notes.push(`role ${existing.role.name} → ${role.name}`);
      const kind = linkKindFor(role.key);
      if (kind !== linkKindFor(existing.role.key) && dto.linkId === undefined) {
        // The old link belongs to another kind of record; link by matching email/mobile where possible.
        Object.assign(data, { studentId: null, parentId: null, employeeId: null });
        if (kind !== 'student') {
          const link = await resolveLink(this.prisma, { kind, email: existing.email, phone: existing.phone, excludeUserId: id }).catch(() => null);
          if (link) Object.assign(data, { parentId: link.parentId, employeeId: link.employeeId });
        }
      }
      signOut = true;
    }
    if (dto.status && dto.status !== existing.status) {
      if (id === actor.id) throw forbidden('You cannot change the status of your own account');
      if (existing.role.key === 'super_admin' && dto.status !== 'active') await this.keepOneSuperAdmin(id);
      if (dto.status === 'active') await assertCanActivate(this.prisma, existing);
      data.status = dto.status;
      if (dto.status === 'active') Object.assign(data, { failedLogins: 0, lockedUntil: null });
      notes.push(dto.status === 'active' ? 'reactivated' : dto.status);
      signOut = signOut || dto.status !== 'active';
    }
    if (dto.unlock) {
      Object.assign(data, { failedLogins: 0, lockedUntil: null });
      notes.push('unlocked');
    }
    if (dto.fullName) data.fullName = dto.fullName.trim();
    if (dto.title !== undefined) data.title = dto.title.trim() || null;
    if (dto.phone !== undefined) data.phone = dto.phone.trim() || null;
    if (dto.campusId !== undefined) data.campus = dto.campusId ? { connect: { id: dto.campusId } } : { disconnect: true };
    if (dto.linkId !== undefined) {
      const roleKey = dto.roleKey ?? existing.role.key;
      if (!dto.linkId) {
        Object.assign(data, { studentId: null, parentId: null, employeeId: null });
        notes.push('unlinked from its record');
      } else {
        const link = await resolveLink(this.prisma, { kind: linkKindFor(roleKey), linkId: dto.linkId, email: existing.email, phone: existing.phone, excludeUserId: id });
        Object.assign(data, { studentId: link.studentId, parentId: link.parentId, employeeId: link.employeeId });
        notes.push(`linked to ${link.name}`);
      }
      signOut = true;
    }
    if (Object.keys(data).length === 0) throw badRequest('Nothing to change');

    const user = await this.prisma.user.update({ where: { id }, data, include: { role: true } });
    if (signOut) await this.tokens.revokeAllForUser(id);
    await this.audit.record({
      user: actor,
      action: 'update',
      module: 'users',
      entityType: 'user',
      entityId: id,
      description: `Updated ${user.fullName}${notes.length ? `: ${notes.join(', ')}` : ''}`,
      req,
    });
    const links = await linkedRecords(this.prisma, [user]);
    return ok(userRow(user, links.get(user.id) ?? null), notes.includes('unlocked') ? 'Account unlocked' : notes.some((n) => n.startsWith('linked')) ? 'Account linked' : 'User updated');
  }

  private async keepOneSuperAdmin(excludingId: string) {
    const others = await this.prisma.user.count({ where: { role: { key: 'super_admin' }, status: 'active', NOT: { id: excludingId } } });
    if (others === 0) throw badRequest('At least one active Super Admin must remain');
  }
}

@Controller('roles')
@RequirePermissions('users.manage')
export class RolesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cache: PermissionCacheService,
  ) {}

  @Get()
  async roles() {
    const [roles, permissions] = await Promise.all([
      this.prisma.role.findMany({ orderBy: { sortOrder: 'asc' }, include: { permissions: { select: { permissionKey: true } }, _count: { select: { users: true } } } }),
      this.prisma.permission.findMany({ orderBy: { sortOrder: 'asc' } }),
    ]);
    return {
      roles: roles.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        scope: r.scope,
        permissions: r.permissions.map((p) => p.permissionKey),
        users: r._count.users,
      })),
      permissions: permissions.map((p) => ({ key: p.key, module: p.module, description: p.description })),
    };
  }

  /** Replaces a role's permissions. Only a Super Admin can do this; Super Admin always keeps everything. */
  @Put(':id/permissions')
  putPermissions(@Param('id') id: string, @Body() body: { permissions: string[] }, @CurrentUser() actor: AuthUser, @Req() req: Request) {
    return this.setPermissions(id, body, actor, req);
  }

  private async setPermissions(id: string, body: { permissions: string[] }, actor: AuthUser, req: Request) {
    if (actor.roleKey !== 'super_admin') throw forbidden('Only a Super Admin can change role permissions');
    const role = await this.prisma.role.findUnique({ where: { id }, include: { permissions: true } });
    if (!role) throw notFound('Role');
    if (role.key === 'super_admin') throw badRequest('Super Admin always holds every permission');
    if (!Array.isArray(body?.permissions)) throw badRequest('Send the list of permissions');
    const valid = new Set((await this.prisma.permission.findMany({ select: { key: true } })).map((p) => p.key));
    const next = [...new Set(body.permissions)].filter((p) => valid.has(p));
    const before = role.permissions.map((p) => p.permissionKey);
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId: id } }),
      this.prisma.rolePermission.createMany({ data: next.map((permissionKey) => ({ roleId: id, permissionKey })) }),
    ]);
    this.cache.invalidate(id);
    const added = next.filter((p) => !before.includes(p));
    const removed = before.filter((p) => !next.includes(p));
    await this.audit.record({
      user: actor,
      action: 'update',
      module: 'users',
      entityType: 'role',
      entityId: role.key,
      description: `Changed permissions of ${role.name} (+${added.length} / −${removed.length})`,
      metadata: { added, removed },
      req,
    });
    return ok({ id, permissions: next }, 'Role permissions updated');
  }
}
