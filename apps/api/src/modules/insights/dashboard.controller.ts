import { Controller, Get, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { CommandCenterService } from './command-center.service';
import { OverviewService } from './overview.service';

class DashboardQueryDto {
  @IsOptional() @IsIn(['campus', 'group']) scope?: string;
  @IsOptional() @IsString() campusId?: string;
}

/** The two landing dashboards. Both are polled by the web app, so each is a bounded set of aggregate queries. */
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly commandCenter: CommandCenterService,
    private readonly overview: OverviewService,
  ) {}

  /** Principal / Management home, the dashboard picture on other homes, and the prototype screens' live figures. */
  @Get('command-center')
  @RequirePermissions('dashboard.view', 'students.read', 'prototype.view')
  commandCenterView(@Query() q: DashboardQueryDto, @CurrentUser() user: AuthUser) {
    return this.commandCenter.get(user, q);
  }

  /** Owner / Super Admin overview: revenue needs finance.read; activity and the school panel need audit.read. */
  @Get('overview')
  @RequirePermissions('finance.read', 'audit.read')
  overviewView(@Query() q: DashboardQueryDto, @CurrentUser() user: AuthUser) {
    return this.overview.get(user, q);
  }
}
