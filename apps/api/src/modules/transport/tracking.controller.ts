import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthedRequest, AuthUser } from '../../common/auth-user';
import { CurrentUser, Public, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { ScopeService } from '../../common/scope.service';
import { DevicesService } from './devices.service';
import { campusParam } from './geo';
import {
  AssignDeviceDto, AssignmentsQuery, DevicesQuery, HistoryQuery, LookupQuery, RegisterDeviceDto, TrackingProfileDto, TrackingQuery, UnassignDto,
  UpdateDeviceDto,
} from './dto';
import { IngestService } from './ingest.service';
import { LocationService } from './location.service';

const TRACK_READ = ['tracking.read_all', 'tracking.read_assigned', 'tracking.manage'];
const DEVICE_READ = ['tracking.read_all', 'tracking.manage'];

/** Student tracking list and map, and tracking settings per student. */
@Controller('tracking')
export class TrackingController {
  constructor(private readonly locations: LocationService) {}

  @Get('students')
  @RequirePermissions(...TRACK_READ)
  students(@Query() q: TrackingQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.locations.list(user, q, req);
  }

  @Get('map')
  @RequirePermissions(...TRACK_READ)
  map(@Query() q: TrackingQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.locations.map(user, q, req);
  }

  @Patch('students/:id/profile')
  @RequirePermissions('tracking.manage')
  async profile(@Param('id') id: string, @Body() dto: TrackingProfileDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.locations.assertCanView(user, id);
    const r = await this.locations.updateProfile(id, dto, user, req);
    return ok(r, 'Tracking settings updated');
  }
}

/** Location of one student for staff screens (Student Tracking detail, Student 360 tracking tab). */
@Controller('students')
export class StudentLocationController {
  constructor(private readonly locations: LocationService) {}

  @Get(':id/location')
  @RequirePermissions(...TRACK_READ)
  async current(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.locations.assertCanView(user, id);
    return this.locations.current(id, user, req);
  }

  @Get(':id/location/history')
  @RequirePermissions('tracking.history')
  async history(@Param('id') id: string, @Query() q: HistoryQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.locations.assertCanView(user, id);
    return this.locations.history(id, q, user, req);
  }
}

/** GPS devices: register (token shown once), labels, status, lookup by scanned QR. */
@Controller('devices')
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly scope: ScopeService,
  ) {}

  @Get()
  @RequirePermissions(...DEVICE_READ)
  list(@Query() q: DevicesQuery, @CurrentUser() user: AuthUser) {
    return this.devices.list(q, this.scope.campus(user, campusParam(q.campusId)));
  }

  @Get('summary')
  @RequirePermissions(...DEVICE_READ)
  summary(@Query() q: DevicesQuery, @CurrentUser() user: AuthUser) {
    return this.devices.summary(this.scope.campus(user, campusParam(q.campusId)));
  }

  @Get('lookup')
  @RequirePermissions(...DEVICE_READ)
  lookup(@Query() q: LookupQuery) {
    return this.devices.lookup(q.code);
  }

  @Get(':id')
  @RequirePermissions(...DEVICE_READ)
  detail(@Param('id') id: string) {
    return this.devices.detail(id);
  }

  @Post()
  @RequirePermissions('tracking.manage')
  async register(@Body() dto: RegisterDeviceDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.devices.register(dto, user, req);
    return ok(r, `${r.device.deviceCode} registered — store the token in the device now`);
  }

  @Put(':id')
  @RequirePermissions('tracking.manage')
  async update(@Param('id') id: string, @Body() dto: UpdateDeviceDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.devices.update(id, dto, user, req);
    return ok(r.device, r.message);
  }

  @Post(':id/token')
  @RequirePermissions('tracking.manage')
  async token(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.devices.issueToken(id, user, req);
    return ok(r, `New token issued for ${r.deviceCode}`);
  }
}

/** Which student carries which device; ended assignments stay with their locations. */
@Controller('device-assignments')
export class DeviceAssignmentsController {
  constructor(
    private readonly devices: DevicesService,
    private readonly scope: ScopeService,
  ) {}

  @Get()
  @RequirePermissions(...DEVICE_READ)
  list(@Query() q: AssignmentsQuery, @CurrentUser() user: AuthUser) {
    return this.devices.assignments(q, q.campusId ? this.scope.campus(user, campusParam(q.campusId)) : user.scope === 'school' ? undefined : this.scope.campus(user));
  }

  @Post()
  @RequirePermissions('tracking.manage')
  async assign(@Body() dto: AssignDeviceDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.devices.assign(dto, user, req);
    return ok(r.data, r.message);
  }

  @Post(':id/unassign')
  @RequirePermissions('tracking.manage')
  async unassign(@Param('id') id: string, @Body() dto: UnassignDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const message = await this.devices.unassign(id, dto.reason, user, req);
    return ok({ id }, message);
  }
}

/**
 * Location ingest for GPS devices — public, authenticated by the device token:
 *   POST /api/v1/location   Authorization: Bearer <device token>   (optional X-Device-Id: <device ID or IMEI>)
 *   body: { latitude, longitude, accuracy?, speed? (m/s) | speedKmph?, heading?, battery? (0–100), recordedAt? (ISO or epoch) }
 *         or an array of those, or { points: [...] } for buffered fixes.
 * Signed-in integrations with tracking.ingest may post the same body with deviceCode or studentId.
 * POST /api/tracking/ingest is the same endpoint. GET /api/v1/location checks a token.
 */
@Controller()
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Public()
  @Post('v1/location')
  async location(@Body() body: unknown, @Req() req: AuthedRequest) {
    return ok(await this.ingest.ingest(req, body, req.user), 'Location received');
  }

  @Public()
  @Post('tracking/ingest')
  async alias(@Body() body: unknown, @Req() req: AuthedRequest) {
    return ok(await this.ingest.ingest(req, body, req.user), 'Location received');
  }

  @Public()
  @Get('v1/location')
  async check(@Req() req: AuthedRequest) {
    return ok(await this.ingest.whoAmI(req), 'Device token accepted');
  }
}
