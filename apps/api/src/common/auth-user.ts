import type { Request } from 'express';

/** The signed-in user attached to each request by the auth guard. */
export interface AuthUser {
  id: string;
  fullName: string;
  email: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  /** school | class | family | self */
  scope: string;
  campusId: string | null;
  studentId: string | null;
  parentId: string | null;
  employeeId: string | null;
  permissions: Set<string>;
  sessionFamilyId: string | null;
  clientType: 'web' | 'mobile';
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

export function can(user: AuthUser | undefined, ...perms: string[]): boolean {
  if (!user) return false;
  return perms.length === 0 || perms.some((p) => user.permissions.has(p));
}

export function clientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first?.trim() || req.socket?.remoteAddress || null) ?? null;
}

export function userAgent(req: Request): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 300) : null;
}

export function clientType(req: Request): 'web' | 'mobile' {
  const h = req.headers['x-client-type'];
  return h === 'mobile' ? 'mobile' : 'web';
}
