import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { SearchService } from '../search/search.service';
import { CounsellingController } from './counselling.controller';
import { EmergencyController, EmergencyService } from './emergency.controller';
import { GateController, SafetyStudentsController } from './gate.controller';
import { GateEventsService } from './gate.service';
import { IncidentsController } from './incidents.controller';
import { IncidentsService } from './incidents.service';
import { InfirmaryController } from './infirmary.controller';
import { PickupController } from './pickup.controller';
import { PickupService } from './pickup.service';
import { SafetyContext, SENSITIVE } from './safety.util';
import { VisitorsController, VisitorsService } from './visitors.controller';

/** Adds incidents and visitors to the global Ctrl K search. */
@Injectable()
class SafetySearch implements OnModuleInit {
  constructor(
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
    private readonly ctx: SafetyContext,
  ) {}

  onModuleInit() {
    this.search.register(async (user, q) => {
      if (!user.permissions.has('safety.read') && !user.permissions.has('safety.manage')) return [];
      const campus = this.ctx.campus(user);
      const campusWhere = campus ? { campusId: campus } : {};
      const [incidents, visitors] = await Promise.all([
        this.prisma.safetyIncident.findMany({
          where: {
            ...campusWhere,
            ...(user.permissions.has(SENSITIVE) ? {} : { isConfidential: false }),
            OR: [{ code: { contains: q, mode: 'insensitive' } }, { summary: { contains: q, mode: 'insensitive' } }],
          },
          orderBy: { createdAt: 'desc' },
          take: 4,
        }),
        this.prisma.safetyVisitor.findMany({
          where: { ...campusWhere, OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { badgeNo: { contains: q, mode: 'insensitive' } }] },
          orderBy: { checkedInAt: 'desc' },
          take: 3,
        }),
      ]);
      return [
        ...incidents.map((i) => ({ group: 'Safety', label: `${i.code} · ${i.summary}`, meta: `${i.incidentType} · ${i.severity} · ${i.status}`, icon: 'shield', route: '/safeguarding' })),
        ...visitors.map((v) => ({ group: 'Visitors', label: v.fullName, meta: `${v.badgeNo} · ${v.status} · ${v.purpose}`, icon: 'idCard', route: `/visitors?q=${encodeURIComponent(v.badgeNo)}` })),
      ];
    });
  }
}

/**
 * Safety: smart gate, pickup authorisation, visitors, incidents and safeguarding, emergency broadcasts,
 * infirmary and counselling. GateEventsService, PickupService and IncidentsService are exported for the
 * family portal and dashboards.
 */
@Module({
  controllers: [
    GateController,
    SafetyStudentsController,
    PickupController,
    VisitorsController,
    IncidentsController,
    EmergencyController,
    InfirmaryController,
    CounsellingController,
  ],
  providers: [SafetyContext, GateEventsService, IncidentsService, PickupService, VisitorsService, EmergencyService, SafetySearch],
  exports: [SafetyContext, GateEventsService, IncidentsService, PickupService],
})
export class SafetyModule {}
