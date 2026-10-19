import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { forbidden } from '../../common/errors';
import { ListQuery } from '../../common/paging';
import { CircularsService } from './circulars.service';
import { AckQuery, AudienceCountDto, CircularDto, CircularQuery } from './dto';
import { IdPipe } from './id.pipe';

/** Circulars (also listed on the operations Op Circulars screen) and their acknowledgements. */
const READ = ['communication.read', 'communication.send', 'operations.read'];

/** Approving (release / return / withdraw) needs both send and broadcast rights. */
function assertApprover(user: AuthUser) {
  if (!user.permissions.has('communication.send') || !user.permissions.has('notifications.broadcast')) {
    throw forbidden('Only approvers who can send school-wide notifications can do this');
  }
}

@Controller('circulars')
export class CircularsController {
  constructor(private readonly circulars: CircularsService) {}

  @Get()
  @RequirePermissions(...READ)
  list(@Query() q: CircularQuery, @CurrentUser() user: AuthUser) {
    return this.circulars.list(user, q);
  }

  @Get('summary')
  @RequirePermissions(...READ)
  summary(@Query() q: ListQuery, @CurrentUser() user: AuthUser) {
    return this.circulars.summary(user, q.campusId);
  }

  /** How many families (or staff accounts) an audience reaches, for the audience picker. */
  @Post('audience-count')
  @RequirePermissions('communication.read', 'communication.send')
  audienceCount(@Body() dto: AudienceCountDto) {
    return this.circulars.audienceCount(dto);
  }

  @Post()
  @RequirePermissions('communication.send')
  create(@Body() dto: CircularDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.circulars.create(dto, user, req);
  }

  @Get(':id')
  @RequirePermissions(...READ)
  get(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.circulars.get(id, user);
  }

  @Put(':id')
  @RequirePermissions('communication.send')
  update(@Param('id', IdPipe) id: string, @Body() dto: CircularDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.circulars.update(id, dto, user, req);
  }

  @Get(':id/acknowledgements')
  @RequirePermissions(...READ)
  acknowledgements(@Param('id', IdPipe) id: string, @Query() q: AckQuery, @CurrentUser() user: AuthUser) {
    return this.circulars.acknowledgements(id, q, user);
  }

  @Post(':id/submit')
  @RequirePermissions('communication.send')
  submit(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.circulars.submit(id, user, req);
  }

  @Post(':id/release')
  @RequirePermissions('notifications.broadcast')
  release(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertApprover(user);
    return this.circulars.release(id, user, req);
  }

  @Post(':id/return')
  @RequirePermissions('notifications.broadcast')
  giveBack(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertApprover(user);
    return this.circulars.returnToDraft(id, user, req);
  }

  @Post(':id/withdraw')
  @RequirePermissions('notifications.broadcast')
  withdraw(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertApprover(user);
    return this.circulars.withdraw(id, user, req);
  }

  @Post(':id/remind')
  @RequirePermissions('communication.send')
  remind(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.circulars.remind(id, user, req);
  }
}
