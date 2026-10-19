import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { notFound } from '../../common/errors';
import { ScopeService } from '../../common/scope.service';
import { AssignStudentDto, BoardingDto, BusLocationDto, NotifyDto, RouteDto, RoutesQuery, RunDto, StopDto, StopOrderDto, VehicleDto } from './dto';
import { campusParam, isUuid } from './geo';
import { TransportService } from './transport.service';

const READ = ['transport.read', 'transport.manage'];

/** Routes, stops, vehicles, live bus state, run status, parent messages and boarding. */
@Controller('transport')
export class TransportController {
  constructor(
    private readonly transport: TransportService,
    private readonly scope: ScopeService,
  ) {}

  // ---- Routes ----

  @Get('routes')
  @RequirePermissions(...READ)
  list(@Query() q: RoutesQuery, @CurrentUser() user: AuthUser) {
    return this.transport.list(this.scope.campus(user, campusParam(q.campusId)), q.q);
  }

  @Post('routes')
  @RequirePermissions('transport.manage')
  async create(@Body() dto: RouteDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    this.scope.campus(user, dto.campusId);
    const r = await this.transport.saveRoute(null, dto, user, req);
    return ok(r.row, `Route ${r.row.code} created`);
  }

  @Get('routes/:id')
  @RequirePermissions(...READ)
  async detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const d = await this.transport.detail(id);
    this.scope.campus(user, d.campusId);
    return d;
  }

  @Put('routes/:id')
  @RequirePermissions('transport.manage')
  async update(@Param('id') id: string, @Body() dto: RouteDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    this.scope.campus(user, (await this.transport.getRoute(id)).campusId);
    const r = await this.transport.saveRoute(id, dto, user, req);
    return ok(r.row, `Route ${r.row.code} saved`);
  }

  @Delete('routes/:id')
  @RequirePermissions('transport.manage')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    this.scope.campus(user, (await this.transport.getRoute(id)).campusId);
    const r = await this.transport.deleteRoute(id, user, req);
    return ok({ id }, `Route ${r.code} deleted`);
  }

  @Patch('routes/:id/run')
  @RequirePermissions('transport.manage')
  async run(@Param('id') id: string, @Body() dto: RunDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const message = await this.transport.updateRun(id, dto, user, req);
    return ok({ id, runStatus: dto.runStatus }, message);
  }

  @Post('routes/:id/notify')
  @RequirePermissions('transport.manage')
  async notify(@Param('id') id: string, @Body() dto: NotifyDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const message = await this.transport.notifyRoute(id, dto.message, user, req);
    return ok({ id }, message);
  }

  /** Bus position from the attendant app (when the bus has no mounted tracker). */
  @Post('routes/:id/location')
  @RequirePermissions('transport.manage', 'tracking.ingest')
  async busLocation(@Param('id') id: string, @Body() dto: BusLocationDto) {
    const route = await this.transport.getRoute(id);
    const now = Date.now();
    let recordedAt = dto.recordedAt ? new Date(dto.recordedAt) : new Date(now);
    if (Number.isNaN(recordedAt.getTime()) || recordedAt.getTime() > now + 120_000) recordedAt = new Date(now);
    const n = await this.transport.recordBusPings([route.id], [{
      latitude: dto.latitude, longitude: dto.longitude, speedKmph: dto.speedKmph ?? null, heading: dto.heading ?? null, accuracy: dto.accuracy ?? null, recordedAt,
    }], { source: 'app' });
    return ok({ accepted: n }, 'Bus position received');
  }

  // ---- Stops ----

  @Post('routes/:id/stops')
  @RequirePermissions('transport.manage')
  async addStop(@Param('id') id: string, @Body() dto: StopDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const s = await this.transport.addStop(id, dto, user, req);
    return ok({ id: s.id, sequence: s.sequence }, `Stop ${s.sequence}. ${s.name} added`);
  }

  @Put('routes/:id/stops/order')
  @RequirePermissions('transport.manage')
  async reorder(@Param('id') id: string, @Body() dto: StopOrderDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.transport.reorderStops(id, dto.stopIds, user, req);
    return ok({ id }, 'Stop order saved');
  }

  @Put('routes/:id/stops/:stopId')
  @RequirePermissions('transport.manage')
  async updateStop(@Param('id') id: string, @Param('stopId') stopId: string, @Body() dto: StopDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!isUuid(stopId)) throw notFound('Stop');
    const s = await this.transport.updateStop(id, stopId, dto, user, req);
    return ok({ id: s.id }, `Stop ${s.name} saved`);
  }

  @Delete('routes/:id/stops/:stopId')
  @RequirePermissions('transport.manage')
  async deleteStop(@Param('id') id: string, @Param('stopId') stopId: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!isUuid(stopId)) throw notFound('Stop');
    const s = await this.transport.deleteStop(id, stopId, user, req);
    return ok({ id: stopId }, `Stop ${s.name} removed`);
  }

  // ---- Students on a route ----

  @Post('routes/:id/students')
  @RequirePermissions('transport.manage')
  async assign(@Param('id') id: string, @Body() dto: AssignStudentDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const message = await this.transport.assignStudent(id, dto, user, req);
    return ok({ routeId: id, studentId: dto.studentId }, message);
  }

  @Delete('routes/:id/students/:studentId')
  @RequirePermissions('transport.manage')
  async unassign(@Param('id') id: string, @Param('studentId') studentId: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const message = await this.transport.unassignStudent(id, studentId, user, req);
    return ok({ routeId: id, studentId }, message);
  }

  // ---- Vehicles ----

  @Get('vehicles')
  @RequirePermissions(...READ)
  vehicles(@Query() q: RoutesQuery, @CurrentUser() user: AuthUser) {
    return this.transport.vehicles(this.scope.campus(user, campusParam(q.campusId)));
  }

  @Post('vehicles')
  @RequirePermissions('transport.manage')
  async addVehicle(@Body() dto: VehicleDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const v = await this.transport.saveVehicle(null, dto, user, req);
    return ok({ id: v.id }, `${v.busNo} added`);
  }

  @Put('vehicles/:id')
  @RequirePermissions('transport.manage')
  async updateVehicle(@Param('id') id: string, @Body() dto: VehicleDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const v = await this.transport.saveVehicle(id, dto, user, req);
    return ok({ id: v.id }, `${v.busNo} saved`);
  }

  @Delete('vehicles/:id')
  @RequirePermissions('transport.manage')
  async deleteVehicle(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const v = await this.transport.deleteVehicle(id, user, req);
    return ok({ id }, `${v.busNo} removed`);
  }

  // ---- Boarding ----

  @Get('boarding/summary')
  @RequirePermissions(...READ)
  boardingSummary(@Query() q: RoutesQuery, @CurrentUser() user: AuthUser) {
    return this.transport.boardingSummary(this.scope.campus(user, campusParam(q.campusId)));
  }

  @Post('boarding')
  @RequirePermissions('transport.manage')
  async board(@Body() dto: BoardingDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.transport.recordBoarding(dto, user, req);
    return ok(r.data, r.message);
  }
}
