import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ListQuery } from '../../common/paging';
import { BookingStatusDto, PtmPatchDto, PtmQuery, PtmSessionDto } from './dto';
import { IdPipe } from './id.pipe';
import { PtmService } from './ptm.service';

/** Parent–teacher meetings (staff side). Families book through the family portal. */
@Controller('ptm')
export class PtmController {
  constructor(private readonly ptm: PtmService) {}

  @Get('summary')
  @RequirePermissions('communication.read')
  summary(@Query() q: ListQuery, @CurrentUser() user: AuthUser) {
    return this.ptm.summary(user, q.campusId);
  }

  @Get('sessions')
  @RequirePermissions('communication.read')
  list(@Query() q: PtmQuery, @CurrentUser() user: AuthUser) {
    return this.ptm.list(user, q);
  }

  @Post('sessions')
  @RequirePermissions('communication.send')
  create(@Body() dto: PtmSessionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.ptm.create(dto, user, req);
  }

  @Get('sessions/:id')
  @RequirePermissions('communication.read')
  detail(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.ptm.detail(id, user);
  }

  @Patch('sessions/:id')
  @RequirePermissions('communication.send')
  patch(@Param('id', IdPipe) id: string, @Body() dto: PtmPatchDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.ptm.patch(id, dto, user, req);
  }

  @Post('sessions/:id/notify')
  @RequirePermissions('communication.send')
  notify(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.ptm.notify(id, user, req);
  }

  @Post('bookings/:id/status')
  @RequirePermissions('communication.send')
  bookingStatus(@Param('id', IdPipe) id: string, @Body() dto: BookingStatusDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.ptm.setBookingStatus(id, dto, user, req);
  }
}
