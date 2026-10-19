import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthedRequest, AuthUser } from './auth-user';

export const IS_PUBLIC = 'isPublic';
/** The route needs no sign-in. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_PERMISSIONS = 'requiredPermissions';
/** The caller needs at least one of these permissions. */
export const RequirePermissions = (...perms: string[]) => SetMetadata(REQUIRED_PERMISSIONS, perms);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return req.user as AuthUser;
});
