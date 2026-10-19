import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ListQuery } from '../../common/paging';
import { CommunicationsService } from './communications.service';
import { CommQuery, LogInteractionDto, SendMessageDto, ThreadQuery, ThreadReplyDto } from './dto';
import { IdPipe } from './id.pipe';
import { ThreadsService } from './threads.service';

/** The family communication log, the unanswered queue and outbound messages. */
@Controller('communications')
export class CommunicationsController {
  constructor(
    private readonly comms: CommunicationsService,
    private readonly threads: ThreadsService,
  ) {}

  @Get()
  @RequirePermissions('communication.read')
  list(@Query() q: CommQuery, @CurrentUser() user: AuthUser) {
    return this.comms.list(user, q);
  }

  @Get('summary')
  @RequirePermissions('communication.read')
  async summary(@Query() q: ListQuery, @CurrentUser() user: AuthUser) {
    const [s, unreadThreads] = await Promise.all([this.comms.summary(user, q.campusId), this.threads.unreadCount(user, q.campusId)]);
    return { ...s, unreadThreads };
  }

  /** Log a phone call or an internal note. */
  @Post()
  @RequirePermissions('communication.send')
  log(@Body() dto: LogInteractionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.comms.logInteraction(dto, user, req);
  }

  @Post('send')
  @RequirePermissions('communication.send')
  send(@Body() dto: SendMessageDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.comms.send(dto, user, req);
  }

  @Post(':id/replied')
  @RequirePermissions('communication.send')
  replied(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.comms.markReplied(id, user, req);
  }
}

/** Parent-app conversations, as staff see them. */
@Controller('communication/threads')
export class ThreadsController {
  constructor(private readonly threads: ThreadsService) {}

  @Get()
  @RequirePermissions('communication.read')
  list(@Query() q: ThreadQuery, @CurrentUser() user: AuthUser) {
    return this.threads.list(user, q);
  }

  @Get(':id')
  @RequirePermissions('communication.read')
  detail(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.threads.detail(id, user);
  }

  @Post(':id/reply')
  @RequirePermissions('communication.send')
  reply(@Param('id', IdPipe) id: string, @Body() dto: ThreadReplyDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.threads.reply(id, dto.body, user, req);
  }

  @Post(':id/close')
  @RequirePermissions('communication.send')
  close(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.threads.setStatus(id, 'close', user, req);
  }

  @Post(':id/reopen')
  @RequirePermissions('communication.send')
  reopen(@Param('id', IdPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.threads.setStatus(id, 'reopen', user, req);
  }
}
