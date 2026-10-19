import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { clientIp, userAgent } from '../../common/auth-user';
import { AppError, fieldError } from '../../common/errors';
import { PermissionCacheService } from '../../common/permission-cache.service';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { TokensService } from './tokens.service';

/** At least 10 characters with upper case, lower case and a number (the rule the web app shows). */
export const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/;
export const PASSWORD_HINT = 'At least 10 characters with upper case, lower case and a number';

export interface SessionUser {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  title: string | null;
  role: { key: string; name: string; scope: string; homeRoute: string };
  permissions: string[];
  campusId: string | null;
  campus_name: string | null;
  /** Omitted when no academic year is set up yet. */
  academic_year?: string;
  parentId: string | null;
  studentId: string | null;
  employeeId: string | null;
  mustChangePassword: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly permissions: PermissionCacheService,
  ) {}

  async login(identifier: string, password: string, clientType: 'web' | 'mobile', req: Request) {
    const id = identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: id.toLowerCase() }, { phone: id }, { phone: id.replace(/\s+/g, '') }] },
      include: { role: true },
    });
    const wrong = new AppError(401, 'INVALID_CREDENTIALS', 'The email or mobile number and password do not match.');
    const fail = async (reason: string) => {
      await this.audit.record({
        user: user ? { id: user.id, fullName: user.fullName, roleKey: user.role.key } : null,
        userName: user ? undefined : 'Anonymous',
        action: 'login_failed',
        module: 'auth',
        description: 'Failed sign-in attempt',
        entityType: user ? 'user' : undefined,
        entityId: user?.id,
        metadata: { reason },
        req,
      });
    };

    if (!user) {
      await fail('unknown account');
      throw wrong;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await fail('locked');
      throw new AppError(423, 'ACCOUNT_LOCKED', 'This account is locked after repeated failed sign-ins. Try again later or contact the school office.');
    }
    if (user.status !== 'active') {
      await fail(`account ${user.status}`);
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account is not active. Please contact the school office.');
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      const max = await this.settings.get<number>('auth.max_failed_logins', 5);
      const minutes = await this.settings.get<number>('auth.lockout_minutes', 15);
      const failed = user.failedLogins + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: failed, lockedUntil: failed >= max ? new Date(Date.now() + minutes * 60_000) : null },
      });
      await fail('wrong password');
      throw wrong;
    }

    const ip = clientIp(req);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLogins: 0,
        lockedUntil: null,
        prevLoginAt: user.lastLoginAt,
        prevLoginIp: user.lastLoginIp,
        prevLoginClient: user.lastLoginClient,
        lastLoginAt: new Date(),
        lastLoginIp: ip,
        lastLoginClient: clientType,
      },
    });
    const tokens = await this.tokens.startSession(user.id, { clientType, ip, userAgent: userAgent(req) });
    await this.audit.record({
      user: { id: user.id, fullName: user.fullName, roleKey: user.role.key },
      action: 'login',
      module: 'auth',
      entityType: 'user',
      entityId: user.id,
      description: `${user.fullName} signed in`,
      req,
    });
    return tokens;
  }

  async sessionUser(userId: string): Promise<SessionUser> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { role: true, campus: true } });
    const [perms, year] = await Promise.all([
      this.permissions.forRole(user.roleId),
      this.prisma.academicYear.findFirst({ where: { isCurrent: true } }),
    ]);
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      title: user.title,
      role: { key: user.role.key, name: user.role.name, scope: user.role.scope, homeRoute: user.role.homeRoute },
      permissions: [...perms].sort(),
      campusId: user.campusId,
      campus_name: user.campus?.name ?? null,
      academic_year: year?.label,
      parentId: user.parentId,
      studentId: user.studentId,
      employeeId: user.employeeId,
      mustChangePassword: user.mustChangePassword,
    };
  }

  async changePassword(userId: string, current: string, next: string, req: Request) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { role: true } });
    if (!(await bcrypt.compare(current, user.passwordHash))) throw fieldError('currentPassword', 'Your current password is not correct');
    if (!PASSWORD_RULE.test(next)) throw fieldError('newPassword', PASSWORD_HINT);
    if (await bcrypt.compare(next, user.passwordHash)) throw fieldError('newPassword', 'Choose a password you have not used just now');
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(next, 12), mustChangePassword: false } });
    await this.tokens.revokeAllForUser(userId);
    await this.audit.record({ user: { id: user.id, fullName: user.fullName, roleKey: user.role.key }, action: 'update', module: 'auth', entityType: 'user', entityId: user.id, description: 'Changed own password (signed out everywhere)', req });
  }
}
