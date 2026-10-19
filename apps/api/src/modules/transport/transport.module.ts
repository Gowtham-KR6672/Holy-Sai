import { Module, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { type SearchHit, SearchService } from '../search/search.service';
import { DevicesService } from './devices.service';
import { IngestService } from './ingest.service';
import { LocationService } from './location.service';
import {
  DeviceAssignmentsController, DevicesController, IngestController, StudentLocationController, TrackingController,
} from './tracking.controller';
import { TransportConfig } from './transport-config.service';
import { TransportController } from './transport.controller';
import { TransportService } from './transport.service';

/**
 * Transport and GPS tracking: routes, stops, vehicles, live bus state and boarding (/transport/*),
 * student tracking (/tracking/*, /students/:id/location), GPS devices and assignments (/devices/*,
 * /device-assignments/*) and the device ingest endpoint (/v1/location).
 *
 * Other modules import TransportModule for:
 *  - LocationService.familyCurrent / familyHistory — the parent portal's child location (history limited to
 *    tracking.parent_history_days; every view audited as sensitive). The caller checks the guardian link.
 *  - TransportService.studentBus — a student's bus today (route, run status, ETA, staff, stop, bus position, boarding).
 */
@Module({
  controllers: [TransportController, TrackingController, StudentLocationController, DevicesController, DeviceAssignmentsController, IngestController],
  providers: [TransportConfig, TransportService, LocationService, DevicesService, IngestService],
  exports: [TransportService, LocationService, TransportConfig],
})
export class TransportModule implements OnModuleInit {
  constructor(
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    // Ctrl K: routes (by code, name or area) and GPS devices (by device ID or IMEI).
    this.search.register(async (user, q) => {
      const hits: SearchHit[] = [];
      if (user.permissions.has('transport.read') || user.permissions.has('transport.manage')) {
        const areaRoutes = await this.prisma.transportRouteProfile.findMany({ where: { area: { contains: q, mode: 'insensitive' } }, select: { routeId: true }, take: 10 });
        const routes = await this.prisma.transportRoute.findMany({
          where: {
            isActive: true,
            ...(user.scope !== 'school' && user.campusId ? { campusId: user.campusId } : {}),
            OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }, { vehicleLabel: { contains: q, mode: 'insensitive' } }, { id: { in: areaRoutes.map((r) => r.routeId) } }],
          },
          take: 4,
          orderBy: { code: 'asc' },
        });
        hits.push(...routes.map((r) => ({
          group: 'Transport', label: `${r.code} · ${r.name}`, meta: r.vehicleLabel || 'No vehicle', icon: 'bus', route: `/routes?open=${r.id}`,
        })));
      }
      if (user.permissions.has('tracking.read_all') || user.permissions.has('tracking.manage')) {
        const devices = await this.prisma.trackingDevice.findMany({
          where: { OR: [{ deviceCode: { contains: q, mode: 'insensitive' } }, { imei: { contains: q } }] },
          take: 3,
          orderBy: { deviceCode: 'asc' },
        });
        hits.push(...devices.map((d) => ({
          group: 'GPS devices', label: d.deviceCode, meta: d.status.charAt(0).toUpperCase() + d.status.slice(1), icon: 'navigation', route: `/gps-devices?q=${encodeURIComponent(d.deviceCode)}`,
        })));
      }
      return hits;
    });
  }
}
