import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { ListQuery } from '../../common/paging';
import { TRANSFER_STATUSES, TransfersService } from './transfers.service';

class TransferQuery extends ListQuery {
  @IsOptional() @IsIn([...TRANSFER_STATUSES, 'open']) status?: string;
}

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class CreateTransferDto {
  @IsUUID('all', { message: 'Choose a student' }) studentId: string;
  @IsUUID('all', { message: 'Choose the destination campus' }) toCampusId: string;
  @IsString() @MinLength(5, { message: 'Give a short reason' }) @MaxLength(300) reason: string;
}

class DecisionDto {
  @IsIn(['review', 'approve', 'reject'], { message: 'Choose approve, reject or review' }) action: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class CompleteDto {
  @IsUUID('all', { message: 'Choose the class the student joins' }) sectionId: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** Inter-campus student transfers: request → review → approve / reject → complete (the student record moves). */
@Controller('group/transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  @RequirePermissions('group.read', 'group.manage')
  list(@Query() q: TransferQuery, @CurrentUser() user: AuthUser) {
    return this.transfers.list(user, q);
  }

  @Get('summary')
  @RequirePermissions('group.read', 'group.manage')
  summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    return this.transfers.summary(user, q.campusId);
  }

  @Get(':id')
  @RequirePermissions('group.read', 'group.manage')
  detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.transfers.detail(user, id);
  }

  @Post()
  @RequirePermissions('group.manage')
  async create(@Body() dto: CreateTransferDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return ok(await this.transfers.create(user, dto, req), 'Transfer requested');
  }

  @Post(':id/decision')
  @HttpCode(200)
  @RequirePermissions('group.manage')
  async decide(@Param('id') id: string, @Body() dto: DecisionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { message, ...data } = await this.transfers.decide(user, id, dto, req);
    return ok(data, message);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermissions('group.manage')
  async complete(@Param('id') id: string, @Body() dto: CompleteDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return ok(await this.transfers.complete(user, id, dto, req), 'Transfer completed — the record has moved');
  }
}
