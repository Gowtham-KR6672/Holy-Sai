import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { env } from '../config/env';
import { AppError } from '../common/errors';
import { PlatformDb } from '../tenancy/platform-db.service';

/** The signed-in We School platform admin. */
export interface PlatformAdminUser {
  id: string;
  fullName: string;
  email: string;
}

export interface PlatformRequest extends Request {
  platformAdmin?: PlatformAdminUser;
}

/**
 * Platform routes (/api/platform/…): a platform-admin access token is required. Platform controllers are also
 * @Public() so the school AuthGuard lets them through; this guard does the checking.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly platform: PlatformDb,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<PlatformRequest>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const denied = (message: string) => new AppError(401, 'UNAUTHORIZED', message);
    if (!token) throw denied('Sign in to continue');
    const payload = await this.jwt.verifyAsync<{ sub: string; aud?: string }>(token, { secret: env().platformJwtSecret }).catch(() => null);
    if (!payload || payload.aud !== 'platform') throw denied('Your session has expired');
    const admin = await this.platform.platformAdmin.findUnique({ where: { id: payload.sub }, select: { id: true, fullName: true, email: true, status: true } });
    if (!admin || admin.status !== 'active') throw denied('This account is not active');
    req.platformAdmin = { id: admin.id, fullName: admin.fullName, email: admin.email };
    return true;
  }
}

/** The platform admin of the current request (after PlatformGuard). */
export const CurrentAdmin = createParamDecorator((_data: unknown, ctx: ExecutionContext): PlatformAdminUser => {
  const req = ctx.switchToHttp().getRequest<PlatformRequest>();
  if (!req.platformAdmin) throw new AppError(401, 'UNAUTHORIZED', 'Sign in to continue');
  return req.platformAdmin;
});
