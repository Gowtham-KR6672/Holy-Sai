import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

/** Campuses, years, classes/sections, subjects, routes, staff, houses and roles for forms and filters. */
@Controller('lookups')
export class LookupsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async lookups() {
    const [campuses, years, classes, subjects, staff, routes, houses, roles, routeProfiles] = await Promise.all([
      this.prisma.campus.findMany({ where: { isActive: true }, orderBy: [{ establishedYear: 'asc' }, { name: 'asc' }] }),
      this.prisma.academicYear.findMany({ orderBy: { startsOn: 'desc' } }),
      this.prisma.schoolClass.findMany({ orderBy: [{ gradeLevel: 'asc' }, { name: 'asc' }], include: { sections: { orderBy: { name: 'asc' } } } }),
      this.prisma.subject.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
      this.prisma.employee.findMany({ where: { archivedAt: null, employmentStatus: { not: 'exited' } }, orderBy: { fullName: 'asc' } }),
      this.prisma.transportRoute.findMany({ where: { isActive: true }, orderBy: { code: 'asc' }, include: { stops: { orderBy: { sequence: 'asc' } } } }),
      this.prisma.house.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.role.findMany({ orderBy: { sortOrder: 'asc' } }),
      this.prisma.transportRouteProfile.findMany({ select: { routeId: true, area: true } }),
    ]);
    // The transport module keeps each route's area in its route profile; fall back to the route name.
    const areaOf = new Map(routeProfiles.map((p) => [p.routeId, p.area]));
    return {
      campuses: campuses.map((c) => ({ id: c.id, code: c.code, name: c.name, shortName: c.shortName, place: c.place, curriculum: c.curriculum })),
      academicYears: years.map((y) => ({ id: y.id, label: y.label, startsOn: y.startsOn.toISOString().slice(0, 10), endsOn: y.endsOn.toISOString().slice(0, 10), isCurrent: y.isCurrent })),
      classes: classes.map((c) => ({ id: c.id, name: c.name, gradeLevel: c.gradeLevel, campusId: c.campusId, sections: c.sections.map((s) => ({ id: s.id, name: s.name })) })),
      subjects: subjects.map((s) => ({ id: s.id, code: s.code, name: s.name })),
      staff: staff.map((e) => ({ id: e.id, employeeId: e.code, fullName: e.fullName, designation: e.designation, department: e.department ?? '', employeeType: e.employeeType, campusId: e.campusId })),
      routes: routes.map((r) => ({ id: r.id, code: r.code, name: `Route ${r.code.replace(/^R0?/, '')} · ${r.name}`, area: areaOf.get(r.id) || r.name, campusId: r.campusId, stops: r.stops.map((s) => ({ id: s.id, name: s.name, pickupTime: s.pickupTime })) })),
      houses: houses.map((h) => h.name),
      roles: roles.map((r) => ({ key: r.key, name: r.name })),
    };
  }
}
