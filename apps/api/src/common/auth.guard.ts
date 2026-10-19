import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { env } from '../config/env';
import { AuthedRequest, clientType } from './auth-user';
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators';
import { AppError } from './errors';
import { PermissionCacheService } from './permission-cache.service';
import { PrismaService } from './prisma.service';

interface AccessPayload {
  sub: string;
  fam?: string;
}

/** Verifies the bearer token, loads the user and enforces @RequirePermissions. Runs on every route. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionCacheService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const unauthorized = (message: string) => new AppError(401, 'UNAUTHORIZED', message);

    if (!token) {
      if (isPublic) return true;
      throw unauthorized('Sign in to continue');
    }

    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token, { secret: env().jwtAccessSecret });
    } catch {
      if (isPublic) return true;
      throw unauthorized('Your session has expired');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        fullName: true,
        email: true,
        status: true,
        campusId: true,
        studentId: true,
        parentId: true,
        employeeId: true,
        roleId: true,
        role: { select: { key: true, name: true, scope: true } },
      },
    });
    if (!user || user.status !== 'active') {
      if (isPublic) return true;
      throw unauthorized('This account is not active');
    }

    req.user = {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      roleId: user.roleId,
      roleKey: user.role.key,
      roleName: user.role.name,
      scope: user.role.scope,
      campusId: user.campusId,
      studentId: user.studentId,
      parentId: user.parentId,
      employeeId: user.employeeId,
      permissions: await this.permissions.forRole(user.roleId),
      sessionFamilyId: payload.fam ?? null,
      clientType: clientType(req),
    };

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, targets);
    if (required && required.length > 0 && !required.some((p) => req.user!.permissions.has(p))) {
      throw new AppError(403, 'FORBIDDEN', 'This is not available for your role');
    }
    return true;
  }
}
