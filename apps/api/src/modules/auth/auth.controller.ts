import { Body, Controller, Get, HttpCode, Post, Put, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { AuthUser, clientIp, clientType, userAgent } from '../../common/auth-user';
import { CurrentUser, Public } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from './auth.service';
import { IssuedTokens, TokensService } from './tokens.service';

const COOKIE = 'hs_rt';

class LoginDto {
  @IsString() @MinLength(3) @MaxLength(200) identifier: string;
  @IsString() @MinLength(1) @MaxLength(200) password: string;
  @IsOptional() @IsIn(['web', 'mobile']) clientType?: 'web' | 'mobile';
}

class RefreshDto {
  @IsOptional() @IsString() refreshToken?: string;
}

class PushTokenDto {
  /** Expo push token from the mobile app; null removes it (e.g. notifications turned off). */
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(/^Expo(nent)?PushToken[[^]]{10,200}]$/, { message: 'Not an Expo push token' })
  token: string | null;
  @IsOptional() @IsIn(['ios', 'android', 'web']) platform?: string;
}

class ChangePasswordDto {
  @IsString() currentPassword: string;
  @IsString() @MaxLength(200) newPassword: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ct = dto.clientType ?? clientType(req);
    const tokens = await this.auth.login(dto.identifier, dto.password, ct, req);
    const user = await this.auth.sessionUser((await this.userIdFor(tokens))!);
    return ok(this.respond(tokens, ct, res, user), `Welcome, ${user.fullName}`);
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = dto?.refreshToken ?? (req.cookies?.[COOKIE] as string | undefined);
    if (!raw) throw new AppError(401, 'UNAUTHORIZED', 'Sign in to continue');
    const outcome = await this.tokens.refresh(raw, { ip: clientIp(req), userAgent: userAgent(req) });
    if (outcome.kind === 'reused') {
      const u = await this.prisma.user.findUnique({ where: { id: outcome.userId }, include: { role: true } });
      await this.audit.record({
        user: u ? { id: u.id, fullName: u.fullName, roleKey: u.role.key } : null,
        action: 'login_failed',
        module: 'auth',
        description: 'Refresh token reused after rotation — that sign-in was ended on every tab',
        req,
      });
      this.clearCookie(res);
      throw new AppError(401, 'SESSION_ENDED', 'Your session has ended. Please sign in again.');
    }
    const user = await this.auth.sessionUser(outcome.userId);
    if (user && (await this.prisma.user.count({ where: { id: outcome.userId, status: 'active' } })) === 0) {
      await this.tokens.revokeFamily(outcome.tokens.familyId);
      this.clearCookie(res);
      throw new AppError(401, 'ACCOUNT_INACTIVE', 'This account is not active.');
    }
    await this.prisma.session.updateMany({ where: { familyId: outcome.tokens.familyId, revokedAt: null }, data: { lastActiveAt: new Date() } });
    return ok(this.respond(outcome.tokens, dto?.refreshToken ? 'mobile' : 'web', res, user));
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = dto?.refreshToken ?? (req.cookies?.[COOKIE] as string | undefined);
    const userId = raw ? await this.tokens.revokeByToken(raw) : null;
    this.clearCookie(res);
    // Signing out on the phone stops notifications to that device.
    if (userId && clientType(req) === 'mobile') await this.prisma.user.update({ where: { id: userId }, data: { pushToken: null } }).catch(() => undefined);
    if (userId) {
      const u = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
      if (u) await this.audit.record({ user: { id: u.id, fullName: u.fullName, roleKey: u.role.key }, action: 'logout', module: 'auth', entityType: 'user', entityId: u.id, description: 'Signed out', req });
    }
    return ok(null, 'Signed out');
  }

  /**
   * Rebuild addition: the mobile app registers its Expo push token after sign-in. A device belongs to one account at a
   * time, so the token is removed from any other account first (a shared phone must not receive someone else's alerts).
   */
  @Put('push-token')
  async pushToken(@CurrentUser() user: AuthUser, @Body() dto: PushTokenDto) {
    if (dto.token) {
      await this.prisma.$transaction([
        this.prisma.user.updateMany({ where: { pushToken: dto.token, NOT: { id: user.id } }, data: { pushToken: null } }),
        this.prisma.user.update({ where: { id: user.id }, data: { pushToken: dto.token } }),
      ]);
      return ok({ registered: true }, 'Notifications enabled on this device');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { pushToken: null } });
    return ok({ registered: false }, 'Notifications turned off on this device');
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.sessionUser(user.id);
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    await this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword, req);
    return ok(null, 'Password changed — please sign in again');
  }

  @Get('sessions')
  sessions(@CurrentUser() user: AuthUser) {
    return this.tokens.activeFamilies(user.id);
  }

  @Post('sessions/revoke-all')
  @HttpCode(200)
  async revokeAll(@CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.tokens.revokeAllForUser(user.id);
    await this.audit.record({ user, action: 'update', module: 'auth', entityType: 'user', entityId: user.id, description: 'Signed out of all devices', req });
    return ok(null, 'Signed out of every device');
  }

  /** The user behind a just-issued token family. */
  private async userIdFor(tokens: IssuedTokens) {
    const s = await this.prisma.session.findUnique({ where: { id: tokens.sessionId }, select: { userId: true } });
    return s?.userId;
  }

  private respond(tokens: IssuedTokens, ct: 'web' | 'mobile', res: Response, user: unknown) {
    if (ct === 'mobile') return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, refreshToken: tokens.refreshToken, user };
    res.cookie(COOKIE, tokens.refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env().isProduction,
      path: '/api/auth',
      expires: tokens.refreshExpiresAt,
    });
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, user };
  }

  private clearCookie(res: Response) {
    res.clearCookie(COOKIE, { path: '/api/auth', httpOnly: true, sameSite: 'lax', secure: env().isProduction });
  }
}
