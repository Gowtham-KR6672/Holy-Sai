import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { clientIp, userAgent } from '../common/auth-user';
import { AppError, fieldError } from '../common/errors';
import { PASSWORD_HINT, PASSWORD_RULE } from '../modules/auth/auth.service';
import { PlatformDb } from '../tenancy/platform-db.service';
import { PlatformAudit } from './platform-audit.service';

/** Platform refresh tokens look like "p.<secret>" (school tokens start with the school code). */
const PREFIX = 'p.';
const SESSION_DAYS = 7;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const REUSE_GRACE_MS = 60_000;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export interface PlatformTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface PlatformMe {
  kind: 'platform';
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  mustChangePassword: boolean;
}

/** Sign-in for We School's platform admins (separate tokens, sessions and secret from school users). */
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly platform: PlatformDb,
    private readonly jwt: JwtService,
    private readonly audit: PlatformAudit,
  ) {}

  async login(adminId: string, password: string, req: Request): Promise<{ tokens: PlatformTokens; me: PlatformMe }> {
    const admin = await this.platform.platformAdmin.findUnique({ where: { id: adminId } });
    const wrong = new AppError(401, 'INVALID_CREDENTIALS', 'The email or mobile number and password do not match.');
    const fail = (reason: string) =>
      this.audit.record({ admin: admin ? { id: admin.id, fullName: admin.fullName, email: admin.email } : null, action: 'login_failed', description: 'Failed platform sign-in', metadata: { reason }, req });
    if (!admin) throw wrong;
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      await fail('locked');
      throw new AppError(423, 'ACCOUNT_LOCKED', 'This account is locked after repeated failed sign-ins. Try again later.');
    }
    if (admin.status !== 'active') {
      await fail(`account ${admin.status}`);
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account is not active.');
    }
    if (!(await bcrypt.compare(password, admin.passwordHash))) {
      const failed = admin.failedLogins + 1;
      await this.platform.platformAdmin.update({
        where: { id: admin.id },
        data: { failedLogins: failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
      });
      await fail('wrong password');
      throw wrong;
    }
    await this.platform.platformAdmin.update({ where: { id: admin.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: clientIp(req) } });
    const tokens = await this.issue(admin.id, randomUUID(), req);
    await this.audit.record({ admin: { id: admin.id, fullName: admin.fullName, email: admin.email }, action: 'login', description: `${admin.fullName} signed in`, req });
    return { tokens, me: this.toMe(admin) };
  }

  async refresh(token: string | undefined, req: Request): Promise<{ tokens: PlatformTokens; me: PlatformMe }> {
    const ended = new AppError(401, 'SESSION_ENDED', 'Your session has ended. Please sign in again.');
    if (!token?.startsWith(PREFIX)) throw ended;
    const session = await this.platform.platformSession.findUnique({ where: { tokenHash: sha256(token.slice(PREFIX.length)) }, include: { admin: true } });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.admin.status !== 'active') throw ended;
    if (session.rotatedAt) {
      if (Date.now() - session.rotatedAt.getTime() > REUSE_GRACE_MS) {
        await this.platform.platformSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        throw ended;
      }
      return { tokens: await this.issue(session.adminId, session.familyId, req, session.expiresAt), me: this.toMe(session.admin) };
    }
    const tokens = await this.issue(session.adminId, session.familyId, req, session.expiresAt);
    await this.platform.platformSession.update({ where: { id: session.id }, data: { rotatedAt: new Date(), lastActiveAt: new Date() } });
    return { tokens, me: this.toMe(session.admin) };
  }

  async logout(token: string | undefined) {
    if (!token?.startsWith(PREFIX)) return;
    const session = await this.platform.platformSession.findUnique({ where: { tokenHash: sha256(token.slice(PREFIX.length)) } });
    if (session) await this.platform.platformSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async me(adminId: string): Promise<PlatformMe> {
    return this.toMe(await this.platform.platformAdmin.findUniqueOrThrow({ where: { id: adminId } }));
  }

  async changePassword(adminId: string, current: string, next: string, req: Request) {
    const admin = await this.platform.platformAdmin.findUniqueOrThrow({ where: { id: adminId } });
    if (!(await bcrypt.compare(current, admin.passwordHash))) throw fieldError('currentPassword', 'The current password is not correct');
    if (!PASSWORD_RULE.test(next)) throw fieldError('newPassword', PASSWORD_HINT);
    if (await bcrypt.compare(next, admin.passwordHash)) throw fieldError('newPassword', 'Choose a password you have not used just now');
    await this.platform.platformAdmin.update({ where: { id: adminId }, data: { passwordHash: await bcrypt.hash(next, 12), mustChangePassword: false } });
    await this.platform.platformSession.updateMany({ where: { adminId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({ admin: { id: admin.id, fullName: admin.fullName, email: admin.email }, action: 'update', entityType: 'platform_admin', entityId: admin.id, description: 'Changed own password', req });
  }

  private async issue(adminId: string, familyId: string, req: Request, keepExpiry?: Date): Promise<PlatformTokens> {
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = keepExpiry ?? new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await this.platform.platformSession.create({
      data: { adminId, familyId, tokenHash: sha256(secret), userAgent: userAgent(req), ip: clientIp(req), expiresAt },
    });
    const ttl = env().jwtAccessTtl;
    const accessToken = await this.jwt.signAsync({ sub: adminId, fam: familyId, aud: 'platform' }, { secret: env().platformJwtSecret, expiresIn: ttl });
    return { accessToken, expiresIn: ttl, refreshToken: `${PREFIX}${secret}`, refreshExpiresAt: expiresAt };
  }

  private toMe(a: { id: string; fullName: string; email: string; phone: string | null; mustChangePassword: boolean }): PlatformMe {
    return { kind: 'platform', id: a.id, fullName: a.fullName, email: a.email, phone: a.phone, mustChangePassword: a.mustChangePassword };
  }
}
