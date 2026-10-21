import { Injectable, NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import type { WorkspaceRef } from './context';
import { PlatformDb } from './platform-db.service';
import { SubscriptionStatusService } from './subscription-status.service';
import { TenancyService } from './tenancy.service';

/** Requests rewritten from /api/w/<code>/… carry their school code here (see workspacePathRewrite). */
export interface WorkspaceRoutedRequest extends Request {
  workspaceCode?: string;
}

const WORKSPACE_PATH = /^\/api\/w\/([a-z0-9_]{2,40})(\/[^?#]*)?(\?.*)?$/;
/** GPS devices post with their own bearer token, not a sign-in token. */
const DEVICE_PATHS = /^\/api\/(tracking\/ingest|v1\/location)(\/|\?|$)/;

/**
 * Express middleware (registered first in main.ts): /api/w/<code>/whatsapp/webhook → /api/whatsapp/webhook for
 * that school. Used for webhooks registered with providers and public pages such as certificate verification.
 */
export function workspacePathRewrite(req: WorkspaceRoutedRequest, _res: Response, next: NextFunction) {
  const m = WORKSPACE_PATH.exec(req.url);
  if (m) {
    req.workspaceCode = m[1];
    req.url = `/api${m[2] ?? '/'}${m[3] ?? ''}`;
  }
  next();
}

const blocked = (res: Response, status: number, error: string, message: string) => res.status(status).json({ success: false, error, message, details: [] });

/**
 * Selects the school for each request before guards and handlers run: from the sign-in token's `ws` claim, from a
 * /api/w/<code>/ address, or (GPS ingest) from the device token. Platform pages and sign-in run with no school; the
 * sign-in endpoints enter the right school themselves. A suspended school only admits We School support sessions.
 * Registered through Nest's MiddlewareConsumer so it runs after the body parsers (the context must wrap the rest of
 * the request).
 */
@Injectable()
export class TenancyMiddleware implements NestMiddleware {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly jwt: JwtService,
    private readonly platform: PlatformDb,
    private readonly subscriptions: SubscriptionStatusService,
  ) {}

  async use(req: WorkspaceRoutedRequest, res: Response, next: NextFunction) {
    let found: { ws: WorkspaceRef | null; support: boolean };
    try {
      found = await this.resolve(req);
    } catch (err) {
      next(err);
      return;
    }
    const { ws, support } = found;
    if (req.workspaceCode && !ws) {
      blocked(res, 404, 'NOT_FOUND', 'This school was not found');
      return;
    }
    if (ws?.status === 'suspended' && !support) {
      blocked(res, 403, 'WORKSPACE_SUSPENDED', "This school's We School account is suspended. Please contact We School.");
      return;
    }
    if (!ws && DEVICE_PATHS.test(req.originalUrl ?? req.url)) {
      blocked(res, 401, 'DEVICE_UNKNOWN', 'This device token is not recognised');
      return;
    }
    let subscription = null;
    try {
      subscription = ws ? await this.subscriptions.forWorkspace(ws.id) : null;
    } catch {
      subscription = null;
    }
    this.tenancy.run(ws, next, { subscription });
  }

  private async resolve(req: WorkspaceRoutedRequest): Promise<{ ws: WorkspaceRef | null; support: boolean }> {
    const header = req.headers.authorization ?? '';
    const bearer = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : null;
    const deviceAuth = /^(Bearer|Device)\s+/i.test(header) ? header.replace(/^(Bearer|Device)\s+/i, '').trim() : null;
    let claims: { ws?: string; aud?: string; sup?: string } | null = null;
    if (bearer && bearer.split('.').length === 3) {
      claims = await this.jwt.verifyAsync<{ ws?: string; aud?: string; sup?: string }>(bearer, { secret: env().jwtAccessSecret }).catch(() => null);
    }
    if (req.workspaceCode) {
      const ws = await this.tenancy.byCode(req.workspaceCode);
      return { ws, support: !!claims?.sup && claims.ws === req.workspaceCode };
    }
    if (claims?.ws && claims.aud === 'ws') return { ws: await this.tenancy.byCode(claims.ws), support: !!claims.sup };
    if (DEVICE_PATHS.test(req.originalUrl ?? req.url)) {
      const raw = deviceAuth ?? (typeof req.headers['x-device-token'] === 'string' ? req.headers['x-device-token'].trim() : null);
      if (raw) {
        const hit = await this.platform.deviceToken.findUnique({ where: { tokenHash: createHash('sha256').update(raw).digest('hex') } });
        if (hit) return { ws: await this.tenancy.byId(hit.workspaceId), support: false };
      }
    }
    return { ws: null, support: false };
  }
}
