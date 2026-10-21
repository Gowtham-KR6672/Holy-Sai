import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { CryptoService } from '../../common/crypto.service';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { currentWorkspace, splitRefreshToken } from '../../tenancy/context';
import { SettingsService } from '../settings/settings.service';

/** A token presented again within this window (another tab refreshing at the same moment) is not treated as theft. */
const REUSE_GRACE_MS = 60_000;

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  familyId: string;
  sessionId: string;
}

export type RefreshOutcome = { kind: 'ok'; userId: string; tokens: IssuedTokens } | { kind: 'reused'; userId: string };

@Injectable()
export class TokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    private readonly settings: SettingsService,
  ) {}

  /** A short-lived access token for the current school (its `ws` claim selects the school on each request). */
  async accessToken(userId: string, familyId: string, extra: { sup?: string; ttl?: number } = {}): Promise<{ token: string; expiresIn: number }> {
    const ttl = extra.ttl ?? env().jwtAccessTtl;
    const claims = { sub: userId, fam: familyId, ws: currentWorkspace().code, aud: 'ws', ...(extra.sup ? { sup: extra.sup } : {}) };
    const token = await this.jwt.signAsync(claims, { secret: env().jwtAccessSecret, expiresIn: ttl });
    return { token, expiresIn: ttl };
  }

  /** The secret part of a "<school>.<secret>" refresh token, if it belongs to the current school. */
  private secretOf(token: string): string | null {
    const parts = splitRefreshToken(token);
    return parts && parts.code === currentWorkspace().code ? parts.secret : null;
  }

  /** Starts a new sign-in (a new token family). */
  startSession(userId: string, opts: { clientType: string; ip: string | null; userAgent: string | null }) {
    return this.issue(userId, randomUUID(), opts);
  }

  /** Rotates a refresh token. Concurrent refreshes from several tabs share a short grace window. */
  async refresh(token: string, meta: { ip: string | null; userAgent: string | null }): Promise<RefreshOutcome> {
    const secret = this.secretOf(token);
    const session = secret ? await this.prisma.session.findUnique({ where: { tokenHash: this.crypto.sha256(secret) } }) : null;
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new AppError(401, 'SESSION_ENDED', 'Your session has ended. Please sign in again.');
    }
    const opts = { clientType: session.clientType, ip: meta.ip, userAgent: meta.userAgent };

    if (session.rotatedAt) {
      if (Date.now() - session.rotatedAt.getTime() <= REUSE_GRACE_MS) {
        // Another tab rotated this token a moment ago: hand out a sibling in the same family.
        const tokens = await this.issue(session.userId, session.familyId, opts, session.expiresAt);
        return { kind: 'ok', userId: session.userId, tokens };
      }
      // An old token came back long after rotation: treat it as stolen and end that sign-in everywhere.
      await this.revokeFamily(session.familyId);
      return { kind: 'reused', userId: session.userId };
    }

    const tokens = await this.issue(session.userId, session.familyId, opts, session.expiresAt);
    await this.prisma.session.update({ where: { id: session.id }, data: { rotatedAt: new Date(), replacedById: tokens.sessionId } });
    return { kind: 'ok', userId: session.userId, tokens };
  }

  async revokeByToken(token: string): Promise<string | null> {
    const secret = this.secretOf(token);
    const session = secret ? await this.prisma.session.findUnique({ where: { tokenHash: this.crypto.sha256(secret) } }) : null;
    if (!session) return null;
    await this.revokeFamily(session.familyId);
    return session.userId;
  }

  async revokeFamily(familyId: string) {
    await this.prisma.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async revokeAllForUser(userId: string) {
    await this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** Active sign-ins (one row per device), newest activity first. */
  async activeFamilies(userId: string) {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
    });
    const byFamily = new Map<string, { family_id: string; client_type: string; user_agent: string | null; ip: string | null; started_at: string; last_active_at: string }>();
    for (const r of rows) {
      const cur = byFamily.get(r.familyId);
      const started = cur?.started_at ?? r.createdAt.toISOString();
      byFamily.set(r.familyId, {
        family_id: r.familyId,
        client_type: r.clientType,
        user_agent: r.userAgent,
        ip: r.ip,
        started_at: started,
        last_active_at: r.lastActiveAt.toISOString(),
      });
    }
    return [...byFamily.values()].sort((a, b) => b.last_active_at.localeCompare(a.last_active_at));
  }

  private async issue(
    userId: string,
    familyId: string,
    opts: { clientType: string; ip: string | null; userAgent: string | null },
    keepExpiry?: Date,
  ): Promise<IssuedTokens> {
    const days = await this.settings.get<number>('auth.session_days', 7);
    const expiresAt = keepExpiry ?? new Date(Date.now() + days * 86_400_000);
    const secret = this.crypto.randomToken(32);
    const refreshToken = `${currentWorkspace().code}.${secret}`;
    const row = await this.prisma.session.create({
      data: {
        userId,
        familyId,
        tokenHash: this.crypto.sha256(secret),
        clientType: opts.clientType,
        remember: true,
        ip: opts.ip,
        userAgent: opts.userAgent,
        expiresAt,
      },
    });
    const access = await this.accessToken(userId, familyId);
    return { accessToken: access.token, expiresIn: access.expiresIn, refreshToken, refreshExpiresAt: expiresAt, familyId, sessionId: row.id };
  }
}
