import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { env } from '../config/env';
import { AuthedRequest, clientType } from './auth-user';
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators';
import { AppError } from './errors';
import { PermissionCacheService } from './permission-cache.service';
import { PrismaService } from './prisma.service';
import { CAMPUS_PINNED_ROLES, type RoleKey } from '@holysai/shared';
import { currentSubscription, currentWorkspaceOrNull, pinCampus } from '../tenancy/context';

interface AccessPayload {
  sub: string;
  fam?: string;
  /** The school the token was issued in (TenancyMiddleware selected it from this claim). */
  ws?: string;
  aud?: string;
  /** Set on support sessions opened by a We School platform admin. */
  sup?: string;
}

/** What a Workspace Admin can still reach when the subscription has ended: their session and the renewal pages. */
const RENEWAL_PATHS = /^\/api\/(auth|subscription|notifications\/counts)(\/|$)/;

/** Rewrites ?campusId= in the request address to the pinned campus (read by @Query after the guards run). */
function pinRequestCampus(req: AuthedRequest, campusId: string) {
  const [path, query = ''] = req.url.split('?');
  const params = new URLSearchParams(query);
  params.set('campusId', campusId);
  req.url = `${path}?${params.toString()}`;
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
    // A school token is only valid inside the school it was issued for (older tokens without a school are retired).
    const ws = currentWorkspaceOrNull();
    if (!ws || payload.aud !== 'ws' || payload.ws !== ws.code) {
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
      supportAdminId: payload.sup ?? null,
      pinnedCampusId: null,
    };

    // An expired subscription: Workspace Admins may only renew; everyone else is refused (support always gets in).
    if (currentSubscription()?.status === 'expired' && !payload.sup && !RENEWAL_PATHS.test(req.path)) {
      if (user.role.key === 'super_admin') throw new AppError(402, 'SUBSCRIPTION_EXPIRED', 'Your We School subscription has ended. Renew it to continue.');
      throw new AppError(403, 'SUBSCRIPTION_EXPIRED', "Your school's We School subscription has ended. Please contact your school office.");
    }

    if (CAMPUS_PINNED_ROLES.includes(user.role.key as RoleKey)) {
      if (!user.campusId) throw new AppError(403, 'NO_CAMPUS', 'Your account is not linked to a campus. Ask your Workspace Admin to set it.');
      const requested = typeof req.query?.campusId === 'string' ? req.query.campusId : null;
      if (requested && requested !== 'all' && requested !== user.campusId) throw new AppError(403, 'FORBIDDEN', 'That campus is outside your access');
      req.user.pinnedCampusId = user.campusId;
      pinCampus(user.campusId);
      pinRequestCampus(req, user.campusId);
    }

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, targets);
    if (required && required.length > 0 && !required.some((p) => req.user!.permissions.has(p))) {
      throw new AppError(403, 'FORBIDDEN', 'This is not available for your role');
    }
    return true;
  }
}
