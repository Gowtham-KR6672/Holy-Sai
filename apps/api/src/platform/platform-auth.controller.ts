import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { Public } from '../common/decorators';
import { ok } from '../common/envelope';
import { PlatformAuthService, type PlatformTokens } from './platform-auth.service';
import { CurrentAdmin, PlatformGuard, type PlatformAdminUser } from './platform.guard';

/** Platform admins' refresh cookie (separate from the school cookie hs_rt). */
export const PLATFORM_COOKIE = 'we_prt';
const COOKIE_PATH = '/api/platform/auth';

class ChangePasswordDto {
  @IsString() currentPassword: string;
  @IsString() @MaxLength(200) newPassword: string;
}

/** Sets the platform refresh cookie and returns what the web app keeps (the access token stays in memory). */
export function platformSignedIn(res: Response, tokens: PlatformTokens, me: unknown) {
  res.cookie(PLATFORM_COOKIE, tokens.refreshToken, { httpOnly: true, sameSite: 'lax', secure: env().isProduction, path: COOKIE_PATH, expires: tokens.refreshExpiresAt });
  return { kind: 'platform' as const, accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, user: me };
}

/** Platform admins sign in on the shared page (POST /auth/login); these endpoints keep the session going. */
@Public()
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { tokens, me } = await this.auth.refresh(req.cookies?.[PLATFORM_COOKIE] as string | undefined, req).catch((err) => {
      res.clearCookie(PLATFORM_COOKIE, { path: COOKIE_PATH });
      throw err;
    });
    return ok(platformSignedIn(res, tokens, me));
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[PLATFORM_COOKIE] as string | undefined);
    res.clearCookie(PLATFORM_COOKIE, { path: COOKIE_PATH });
    return ok(null, 'Signed out');
  }

  @UseGuards(PlatformGuard)
  @Get('me')
  me(@CurrentAdmin() admin: PlatformAdminUser) {
    return this.auth.me(admin.id);
  }

  @UseGuards(PlatformGuard)
  @Post('change-password')
  @HttpCode(200)
  async changePassword(@CurrentAdmin() admin: PlatformAdminUser, @Body() dto: ChangePasswordDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.changePassword(admin.id, dto.currentPassword, dto.newPassword, req);
    res.clearCookie(PLATFORM_COOKIE, { path: COOKIE_PATH });
    return ok(null, 'Password changed — please sign in again');
  }
}
