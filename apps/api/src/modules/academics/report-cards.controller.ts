import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { ReportCardsService } from './report-cards.service';

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class BatchQuery {
  @IsOptional() @IsString() studentId?: string;
}

class AdvanceDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(5) toStage: number;
}

class ReviewDto {
  @IsIn(['approve', 'reject', 'regenerate'], { message: 'Unknown action' }) action: 'approve' | 'reject' | 'regenerate';
  @IsOptional() @IsString() @MaxLength(2000, { message: 'Keep the comment under 2000 characters' }) comment?: string;
}

@Controller('academics')
export class ReportCardsController {
  constructor(private readonly cards: ReportCardsService) {}

  @Get('report-cards')
  @RequirePermissions('academics.read')
  overview(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    return this.cards.overview(user, q.campusId);
  }

  @Post('report-cards/release')
  @HttpCode(200)
  @RequirePermissions('academics.manage')
  async release(@Body() body: CampusQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.cards.releaseAll(user, body.campusId, req);
    return ok(r, `${r.released} class${r.released === 1 ? '' : 'es'} approved and released to parents`);
  }

  @Get('report-cards/:id')
  @RequirePermissions('academics.read')
  detail(@Param('id') id: string, @Query() q: BatchQuery, @CurrentUser() user: AuthUser) {
    return this.cards.detail(user, id, q.studentId);
  }

  @Post('report-cards/:id/advance')
  @HttpCode(200)
  @RequirePermissions('academics.manage')
  async advance(@Param('id') id: string, @Body() dto: AdvanceDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.cards.advance(user, id, dto.toStage, req);
    return ok({ stage: r.stage, status: r.status }, r.message);
  }

  @Post('report-cards/:id/draft-missing')
  @HttpCode(200)
  @RequirePermissions('academics.manage')
  async draftMissing(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.cards.draftMissing(user, id, req);
    return ok({ drafted: r.drafted, aiDrafted: r.aiDrafted }, r.message);
  }

  @Post('report-card-comments/:id/review')
  @HttpCode(200)
  @RequirePermissions('academics.manage')
  async review(@Param('id') id: string, @Body() dto: ReviewDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.cards.review(user, id, dto.action, dto.comment, req);
    return ok({ status: r.status }, r.message);
  }
}
