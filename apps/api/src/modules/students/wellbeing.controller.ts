import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { StudentRecordsService } from './records.service';
import { BehaviourListQuery, CampusQuery, CheckinDto, CheckinListQuery, WellbeingBehaviourDto } from './students.dto';
import { STAFF_READ } from './students.util';

/** Behaviour & Wellbeing: the school-wide view of behaviour notes and wellbeing check-ins (same tables as Student 360). */
@Controller('wellbeing')
@RequirePermissions(...STAFF_READ)
export class WellbeingController {
  constructor(private readonly records: StudentRecordsService) {}

  @Get('overview')
  overview(@Query() q: CampusQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.records.overview(user, q.campusId, req);
  }

  @Get('behaviour')
  behaviour(@Query() q: BehaviourListQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.records.listBehaviour(user, q, req);
  }

  @Post('behaviour')
  async addBehaviour(@Body() dto: WellbeingBehaviourDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const row = await this.records.addBehaviour(user, { ...dto, source: 'wellbeing' }, req);
    return ok(row, `${row.type} note saved to ${row.studentName}’s profile`);
  }

  @Get('checkins')
  checkins(@Query() q: CheckinListQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.records.listCheckins(user, q, req);
  }

  @Post('checkins')
  async addCheckin(@Body() dto: CheckinDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const row = await this.records.addCheckin(user, dto, req);
    return ok(row, `Check-in recorded for ${row.studentName}`);
  }
}
