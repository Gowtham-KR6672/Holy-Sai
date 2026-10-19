import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ListQuery } from '../../common/paging';
import { EventDto, EventQuery } from './dto';
import { EventsService } from './events.service';
import { IdPipe } from './id.pipe';

/** The school calendar (staff side). Families read it through the family portal. */
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @RequirePermissions('communication.read')
  list(@Query() q: EventQuery, @CurrentUser() user: AuthUser) {
    return this.events.list(user, q);
  }

  @Get('summary')
  @RequirePermissions('communication.read')
  summary(@Query() q: ListQuery, @CurrentUser() user: AuthUser) {
    return this.events.summary(user, q.campusId);
  }

  @Post()
  @RequirePermissions('communication.send')
  create(@Body() dto: EventDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.events.create(dto, user, req);
  }

  @Put(':id')
  @RequirePermissions('communication.send')
  update(@Param('id', IdPipe) id: string, @Body() dto: EventDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.events.update(id, dto, user, req);
  }

  @Post(':id/notify')
  @RequirePermissions('communication.send')
  notify(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.events.notify(id, user, req);
  }

  @Post(':id/cancel')
  @RequirePermissions('communication.send')
  cancel(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.events.cancel(id, user, req);
  }
}
