import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { Public } from '../common/decorators';
import { ok } from '../common/envelope';
import { badRequest, fieldError, notFound } from '../common/errors';
import { LoginDirectory, normaliseEmail } from '../tenancy/login-directory.service';
import { PlatformDb } from '../tenancy/platform-db.service';
import { PlatformAudit } from './platform-audit.service';
import { CurrentAdmin, PlatformGuard, type PlatformAdminUser } from './platform.guard';
import { temporaryPassword } from './provisioning.service';

class CreateAdminDto {
  @IsString() @MinLength(2) @MaxLength(120) fullName: string;
  @IsEmail({}, { message: 'Enter a valid email' }) @MaxLength(200) email: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
}

class UpdateAdminDto {
  @IsOptional() @IsIn(['active', 'disabled']) status?: 'active' | 'disabled';
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) fullName?: string;
}

/** We School's own administrators. */
@Public()
@UseGuards(PlatformGuard)
@Controller('platform/admins')
export class PlatformAdminsController {
  constructor(
    private readonly platform: PlatformDb,
    private readonly directory: LoginDirectory,
    private readonly audit: PlatformAudit,
  ) {}

  @Get()
  async list() {
    const rows = await this.platform.platformAdmin.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((a) => ({ id: a.id, fullName: a.fullName, email: a.email, phone: a.phone, status: a.status, lastLoginAt: a.lastLoginAt?.toISOString() ?? null, mustChangePassword: a.mustChangePassword }));
  }

  @Post()
  async create(@Body() dto: CreateAdminDto, @CurrentAdmin() actor: PlatformAdminUser, @Req() req: Request) {
    const email = normaliseEmail(dto.email);
    const taken = await this.platform.loginIdentifier.findUnique({ where: { kind_value: { kind: 'email', value: email } } });
    if (taken) throw fieldError('email', 'This email already signs in to We School or a school');
    const password = temporaryPassword();
    const admin = await this.platform.platformAdmin.create({
      data: { fullName: dto.fullName.trim(), email, phone: dto.phone?.trim() || null, passwordHash: await bcrypt.hash(password, 12), mustChangePassword: true },
    });
    await this.directory.writeForPlatformAdmin(admin);
    await this.audit.record({ admin: actor, action: 'create', entityType: 'platform_admin', entityId: admin.id, description: `Added platform admin ${email}`, req });
    return ok({ id: admin.id, email, temporaryPassword: password }, 'Platform admin added');
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateAdminDto, @CurrentAdmin() actor: PlatformAdminUser, @Req() req: Request) {
    const admin = await this.platform.platformAdmin.findUnique({ where: { id } });
    if (!admin) throw notFound('Platform admin');
    if (dto.status && admin.id === actor.id) throw badRequest('You cannot change the status of your own account');
    if (dto.status === 'disabled') {
      const others = await this.platform.platformAdmin.count({ where: { status: 'active', NOT: { id } } });
      if (!others) throw badRequest('At least one active platform admin must remain');
    }
    await this.platform.platformAdmin.update({ where: { id }, data: { status: dto.status, fullName: dto.fullName?.trim() } });
    if (dto.status === 'disabled') await this.platform.platformSession.updateMany({ where: { adminId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({ admin: actor, action: 'update', entityType: 'platform_admin', entityId: id, description: `Updated platform admin ${admin.email}${dto.status ? ` (${dto.status})` : ''}`, req });
    return ok({ id }, 'Platform admin updated');
  }
}
