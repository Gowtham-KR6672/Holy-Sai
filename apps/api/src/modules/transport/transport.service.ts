import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, RouteStop, TransportBoardingEvent, TransportRouteProfile, TransportVehicle } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { AppError, badRequest, conflict, fieldError, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  dateKey, dbDate, distanceM, distanceToPathM, gradeLabel, hasPoint, hhmm, isUuid, localInstant, type LatLng, minutesToTime, pathLengthM,
  round, timeToMinutes,
} from './geo';
import { type CampusGeo, type RunSession, TransportConfig } from './transport-config.service';

export type RunStatus = 'Scheduled' | 'En route' | 'Delayed' | 'At campus' | 'Completed' | 'Maintenance';
export const RUN_STATUSES: RunStatus[] = ['Scheduled', 'En route', 'Delayed', 'At campus', 'Completed', 'Maintenance'];
const RUN_LABEL: Record<string, RunStatus> = {
  scheduled: 'Scheduled', en_route: 'En route', delayed: 'Delayed', at_campus: 'At campus', completed: 'Completed', maintenance: 'Maintenance',
};
const RUN_KEY: Record<RunStatus, string> = {
  Scheduled: 'scheduled', 'En route': 'en_route', Delayed: 'delayed', 'At campus': 'at_campus', Completed: 'completed', Maintenance: 'maintenance',
};
export const STUDENT_MODES = ['both', 'pickup_only', 'drop_only'] as const;

/** A bus position counts as live for alerts and ETA for this long. */
const LIVE_PING_MS = 10 * 60_000;
/** The bus is "at" a stop when it passes within this distance. */
const STOP_RADIUS_M = 150;
const PARENT_ROUTE = '/parent-360?tab=safety';

type RouteWithStops = Prisma.TransportRouteGetPayload<{ include: { stops: true } }>;

export interface BusPoint {
  latitude: number;
  longitude: number;
  speedKmph: number | null;
  heading: number | null;
  accuracy: number | null;
  recordedAt: Date;
}

interface RunState {
  key: string;
  label: RunStatus;
  delayMinutes: number;
  etaText: string | null;
  reason: string | null;
  /** The bus is out on a run (En route / Delayed). */
  moving: boolean;
}

interface StudentRunState {
  boardedAt: Date | null;
  deboardedAt: Date | null;
  lastEvent: 'boarded' | 'deboarded' | null;
  method: string | null;
}

interface Ctx {
  today: string;
  session: RunSession;
  tz: string;
  minutes: number;
  now: Date;
  profiles: Map<string, TransportRouteProfile>;
  vehicles: Map<string, TransportVehicle>;
  employees: Map<string, { id: string; fullName: string; phone: string | null }>;
  campuses: Map<string, CampusGeo>;
  links: Map<string, { studentId: string; stopId: string | null }[]>;
  modes: Map<string, string>;
  events: Map<string, TransportBoardingEvent[]>;
  deviationKm: number;
  speedLimit: number;
}

const busLabelOf = (route: { code: string }, vehicle?: { busNo: string } | null) => vehicle?.busNo ?? route.code;
const naturalCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code, 'en', { numeric: true });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Routes, stops, run state, bus positions and boarding — the transport side of Safety & Transport. */
@Injectable()
export class TransportService {
  private readonly log = new Logger(TransportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TransportConfig,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Run state
  // -------------------------------------------------------------------------

  /** The run state today: a run left over from an earlier day reads Scheduled again (Maintenance carries over). */
  effectiveRun(route: { status: string }, profile: Pick<TransportRouteProfile, 'runDate' | 'delayMinutes' | 'etaText' | 'statusReason'> | null | undefined, today: string): RunState {
    const key = RUN_LABEL[route.status] ? route.status : 'scheduled';
    if (key === 'maintenance') {
      return { key, label: 'Maintenance', delayMinutes: 0, etaText: null, reason: profile?.statusReason ?? null, moving: false };
    }
    if (!profile?.runDate || profile.runDate.toISOString().slice(0, 10) !== today) {
      return { key: 'scheduled', label: 'Scheduled', delayMinutes: 0, etaText: null, reason: null, moving: false };
    }
    const moving = key === 'en_route' || key === 'delayed';
    return { key, label: RUN_LABEL[key], delayMinutes: moving ? profile.delayMinutes : 0, etaText: moving ? profile.etaText : null, reason: profile.statusReason, moving };
  }

  private expectedIn(mode: string | undefined, session: RunSession) {
    const m = mode ?? 'both';
    return m === 'both' || (session === 'morning' ? m === 'pickup_only' : m === 'drop_only');
  }

  private finished(run: RunState, session: RunSession) {
    return session === 'morning' ? run.key === 'at_campus' || run.key === 'completed' : run.key === 'completed';
  }

  private studentStates(events: TransportBoardingEvent[]): Map<string, StudentRunState> {
    const out = new Map<string, StudentRunState>();
    for (const e of events) {
      const s = out.get(e.studentId) ?? { boardedAt: null, deboardedAt: null, lastEvent: null, method: null };
      if (e.eventType === 'boarded') s.boardedAt = e.occurredAt;
      else s.deboardedAt = e.occurredAt;
      s.lastEvent = e.eventType as 'boarded' | 'deboarded';
      s.method = e.method;
      out.set(e.studentId, s);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Context loading
  // -------------------------------------------------------------------------

  private async context(routes: { id: string; driverId: string | null; attendantId: string | null }[]): Promise<Ctx> {
    const clock = await this.config.clock();
    const ids = routes.map((r) => r.id);
    const [profiles, links, events, campuses, deviationKm, speedLimit] = await Promise.all([
      this.prisma.transportRouteProfile.findMany({ where: { routeId: { in: ids } } }),
      this.prisma.studentTransport.findMany({ where: { routeId: { in: ids }, student: { status: 'active' } }, select: { studentId: true, routeId: true, stopId: true } }),
      this.prisma.transportBoardingEvent.findMany({
        where: { routeId: { in: ids }, runDate: dbDate(clock.today), session: clock.session },
        orderBy: { occurredAt: 'asc' },
      }),
      this.config.campuses(),
      this.config.deviationKm(),
      this.config.speedLimitKmph(),
    ]);
    const vehicleIds = [...new Set(profiles.map((p) => p.vehicleId).filter((v): v is string => !!v))];
    const staffIds = [...new Set(routes.flatMap((r) => [r.driverId, r.attendantId]).filter((v): v is string => !!v))];
    const [vehicles, employees, modes] = await Promise.all([
      vehicleIds.length ? this.prisma.transportVehicle.findMany({ where: { id: { in: vehicleIds } } }) : [],
      staffIds.length ? this.prisma.employee.findMany({ where: { id: { in: staffIds } }, select: { id: true, fullName: true, phone: true } }) : [],
      links.length ? this.prisma.transportStudentMode.findMany({ where: { studentId: { in: links.map((l) => l.studentId) } } }) : [],
    ]);
    const linkMap = new Map<string, { studentId: string; stopId: string | null }[]>();
    for (const l of links) linkMap.set(l.routeId, [...(linkMap.get(l.routeId) ?? []), { studentId: l.studentId, stopId: l.stopId }]);
    const eventMap = new Map<string, TransportBoardingEvent[]>();
    for (const e of events) eventMap.set(e.routeId, [...(eventMap.get(e.routeId) ?? []), e]);
    return {
      ...clock,
      profiles: new Map(profiles.map((p) => [p.routeId, p])),
      vehicles: new Map(vehicles.map((v) => [v.id, v])),
      employees: new Map(employees.map((e) => [e.id, e])),
      campuses: new Map(campuses.map((c) => [c.id, c])),
      links: linkMap,
      modes: new Map(modes.map((m) => [m.studentId, m.mode])),
      events: eventMap,
      deviationKm,
      speedLimit,
    };
  }

  private doneKey(today: string, session: RunSession) {
    return `${today}:${session}`;
  }

  private doneStopIds(route: RouteWithStops, ctx: Ctx, events: TransportBoardingEvent[]): Set<string> {
    const profile = ctx.profiles.get(route.id);
    const stored = (profile?.doneStops as Record<string, string[]> | null)?.[this.doneKey(ctx.today, ctx.session)] ?? [];
    const done = new Set<string>(stored);
    const atStop = ctx.session === 'morning' ? 'boarded' : 'deboarded';
    for (const e of events) if (e.eventType === atStop && e.stopId) done.add(e.stopId);
    return done;
  }

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------

  private buildRow(route: RouteWithStops, ctx: Ctx) {
    const profile = ctx.profiles.get(route.id) ?? null;
    const vehicle = profile?.vehicleId ? ctx.vehicles.get(profile.vehicleId) ?? null : null;
    const driver = route.driverId ? ctx.employees.get(route.driverId) ?? null : null;
    const attendant = route.attendantId ? ctx.employees.get(route.attendantId) ?? null : null;
    const campus = ctx.campuses.get(route.campusId);
    const run = this.effectiveRun(route, profile, ctx.today);
    const stops = [...route.stops].sort((a, b) => a.sequence - b.sequence);
    const links = ctx.links.get(route.id) ?? [];
    const events = ctx.events.get(route.id) ?? [];
    const states = this.studentStates(events);
    const done = this.doneStopIds(route, ctx, events);
    const onRoute = new Set(links.map((l) => l.studentId));
    let boardedToday = 0;
    let deboardedToday = 0;
    let onboardNow = 0;
    for (const [sid, s] of states) {
      if (!onRoute.has(sid)) continue;
      if (s.boardedAt) boardedToday++;
      if (s.lastEvent === 'deboarded') deboardedToday++;
      if (s.lastEvent === 'boarded') onboardNow++;
    }
    const busNo = vehicle?.busNo ?? null;
    const label = busLabelOf(route, vehicle);
    const capacity = vehicle?.capacity ?? null;
    const pingAt = profile?.lastPingAt ?? null;
    const live = !!pingAt && ctx.now.getTime() - pingAt.getTime() <= LIVE_PING_MS;
    const location = profile && profile.lastLatitude != null && profile.lastLongitude != null && pingAt
      ? {
        latitude: profile.lastLatitude,
        longitude: profile.lastLongitude,
        speedKmph: profile.lastSpeedKmph != null ? Math.round(profile.lastSpeedKmph) : null,
        heading: profile.lastHeading ?? null,
        recordedAt: pingAt.toISOString(),
      }
      : null;
    const deviationMetres = run.moving && live && profile?.deviationMetres != null ? profile.deviationMetres : null;
    const path = stops.filter(hasPoint).map((s) => ({ name: s.name, latitude: s.latitude, longitude: s.longitude, pickupTime: s.pickupTime ?? '' }));

    // Alerts, most serious first.
    const alerts: { type: string; tone: string; message: string }[] = [];
    if (deviationMetres != null && deviationMetres > ctx.deviationKm * 1000) {
      alerts.push({ type: 'deviation', tone: 'critical', message: `Off the planned route by ${round(deviationMetres / 1000, 1)} km` });
    }
    if (run.moving && live && profile?.lastSpeedKmph != null && profile.lastSpeedKmph > ctx.speedLimit) {
      alerts.push({ type: 'speed', tone: 'critical', message: `Overspeed ${Math.round(profile.lastSpeedKmph)} km/h (limit ${ctx.speedLimit})` });
    }
    if (onboardNow > 0 && this.finished(run, ctx.session)) {
      alerts.push({ type: 'onboard', tone: 'critical', message: `${plural(onboardNow, 'child', 'children')} still marked onboard` });
    }
    if (run.moving && !live) {
      alerts.push({ type: 'gps', tone: 'warning', message: pingAt ? `No GPS for ${Math.round((ctx.now.getTime() - pingAt.getTime()) / 60_000)} min` : 'No GPS position received' });
    }
    if (run.delayMinutes > 0) alerts.push({ type: 'delay', tone: 'warning', message: `Running ${run.delayMinutes} min late${run.reason ? ` · ${run.reason}` : ''}` });
    if (capacity != null && links.length > capacity) alerts.push({ type: 'capacity', tone: 'warning', message: `Over capacity: ${links.length} students for ${capacity} seats` });

    return {
      row: {
        id: route.id,
        code: route.code,
        name: route.name,
        area: profile?.area || '',
        campusId: route.campusId,
        campusName: campus?.name ?? '',
        runStatus: run.label,
        delayMinutes: run.delayMinutes,
        eta: this.eta(run, stops, done, campus, location, live, profile?.lastSpeedKmph ?? null, ctx),
        vehicleId: vehicle?.id ?? null,
        busNo,
        registrationNo: vehicle?.registrationNo ?? null,
        capacity,
        vehicleStatus: vehicle?.status ?? null,
        driverId: route.driverId,
        driverName: driver?.fullName ?? null,
        driverPhone: driver?.phone ?? null,
        attendantId: route.attendantId,
        attendantName: attendant?.fullName ?? null,
        students: links.length,
        stops: stops.length,
        stopsDone: stops.filter((s) => done.has(s.id)).length,
        boardedToday,
        deboardedToday,
        onboardNow,
        deviationMetres,
        alerts,
        location,
        path,
      },
      run,
      label,
      stops,
      links,
      states,
      done,
      events,
      profile,
      vehicle,
    };
  }

  /** ETA text: the manual text, else remaining distance at the current speed, else the next stop's scheduled time plus delay. */
  private eta(
    run: RunState, stops: RouteStop[], done: Set<string>, campus: CampusGeo | undefined, location: LatLng | null, live: boolean, speedKmph: number | null, ctx: Ctx,
  ): string | null {
    if (!run.moving) return null;
    if (run.etaText) return run.etaText;
    const remaining = stops.filter((s) => !done.has(s.id));
    if (location && live) {
      const path: LatLng[] = [location, ...remaining.filter(hasPoint)];
      if (ctx.session === 'morning' && campus && hasPoint(campus)) path.push(campus);
      if (path.length > 1) {
        // Town traffic: never assume faster than the current speed, nor slower than 18 km/h on average.
        const speed = Math.max(speedKmph ?? 0, 18);
        const minutes = Math.ceil((pathLengthM(path) / 1000 / speed) * 60) + remaining.length;
        return `${Math.max(1, minutes)} min`;
      }
    }
    const next = remaining[0];
    const t = timeToMinutes(ctx.session === 'morning' ? next?.pickupTime : next?.dropTime ?? next?.pickupTime);
    return t != null ? minutesToTime(t + run.delayMinutes) : null;
  }

  private async loadRoutes(where: Prisma.TransportRouteWhereInput) {
    const routes = await this.prisma.transportRoute.findMany({ where, include: { stops: true } });
    return routes.sort(naturalCode);
  }

  /** GET /transport/routes — every route with live state, campuses for the map and the fleet summary. */
  async list(campusId: string | undefined, q?: string) {
    const routes = await this.loadRoutes({ isActive: true, ...(campusId ? { campusId } : {}) });
    const ctx = await this.context(routes);
    let rows = routes.map((r) => this.buildRow(r, ctx).row);
    if (q?.trim()) {
      const needle = q.trim().toLowerCase();
      rows = rows.filter((r) => [r.code, r.name, r.area, r.busNo, r.registrationNo, r.driverName, r.attendantName]
        .some((v) => v?.toLowerCase().includes(needle)));
    }
    const campuses = [...ctx.campuses.values()]
      .filter((c) => hasPoint(c) && (!campusId || c.id === campusId))
      .map((c) => ({ id: c.id, name: c.name, shortName: c.shortName, latitude: c.latitude!, longitude: c.longitude!, radiusM: c.radiusM ?? null }));
    const summary = {
      buses: rows.length,
      students: rows.reduce((a, r) => a + r.students, 0),
      onboardNow: rows.reduce((a, r) => a + r.onboardNow, 0),
      atCampus: rows.filter((r) => r.runStatus === 'At campus').length,
      moving: rows.filter((r) => r.runStatus === 'En route' || r.runStatus === 'Delayed').length,
      delayed: rows.filter((r) => r.runStatus === 'Delayed' || r.delayMinutes > 0).length,
      maintenance: rows.filter((r) => r.runStatus === 'Maintenance').length,
      alerts: rows.reduce((a, r) => a + r.alerts.length, 0),
    };
    return { routes: rows, campuses, summary, generatedAt: new Date().toISOString() };
  }

  async getRoute(id: string) {
    if (!isUuid(id)) throw notFound('Route');
    const route = await this.prisma.transportRoute.findUnique({ where: { id }, include: { stops: true } });
    if (!route) throw notFound('Route');
    return route;
  }

  /** GET /transport/routes/:id — the route with stops, students and boarding state, and today's GPS trail. */
  async detail(id: string) {
    const route = await this.getRoute(id);
    const ctx = await this.context([route]);
    const b = this.buildRow(route, ctx);
    const students = b.links.length
      ? await this.prisma.student.findMany({
        where: { id: { in: b.links.map((l) => l.studentId) } },
        select: { id: true, admissionNo: true, fullName: true, section: { select: { name: true, class: { select: { name: true } } } } },
      })
      : [];
    const stopById = new Map(b.stops.map((s) => [s.id, s]));
    const stopOf = new Map(b.links.map((l) => [l.studentId, l.stopId]));
    const atStop = ctx.session === 'morning' ? 'boarded' : 'deboarded';
    const boardedAtStop = new Map<string, Set<string>>();
    for (const e of b.events) {
      const sid = e.stopId ?? stopOf.get(e.studentId);
      if (e.eventType === atStop && sid) boardedAtStop.set(sid, new Set([...(boardedAtStop.get(sid) ?? []), e.studentId]));
    }
    const stopList = b.stops.map((s) => ({
      id: s.id,
      sequence: s.sequence,
      name: s.name,
      latitude: s.latitude ?? 0,
      longitude: s.longitude ?? 0,
      pickupTime: s.pickupTime ?? '',
      dropTime: s.dropTime ?? null,
      students: b.links.filter((l) => l.stopId === s.id).length,
      boarded: boardedAtStop.get(s.id)?.size ?? 0,
      done: b.done.has(s.id),
    }));
    const studentRows = students.map((st) => {
      const stop = stopOf.get(st.id) ? stopById.get(stopOf.get(st.id)!) : undefined;
      const s = b.states.get(st.id);
      return {
        id: st.id,
        admissionNo: st.admissionNo,
        fullName: st.fullName,
        grade: gradeLabel(st.section.class.name),
        section: st.section.name,
        stopId: stop?.id ?? null,
        stopName: stop?.name ?? null,
        pickupTime: stop?.pickupTime ?? null,
        mode: ctx.modes.get(st.id) ?? 'both',
        boardedAt: s?.boardedAt?.toISOString() ?? null,
        deboardedAt: s?.deboardedAt?.toISOString() ?? null,
        lastEvent: s?.lastEvent ?? null,
        method: s?.method ?? null,
        _seq: stop?.sequence ?? 9999,
      };
    }).sort((a, b2) => a._seq - b2._seq || a.fullName.localeCompare(b2.fullName)).map(({ _seq, ...r }) => r);

    // Today's GPS trail for the current run (thinned to at most 500 points).
    const afternoonFrom = await this.config.afternoonFromMinutes();
    const from = ctx.session === 'morning' ? localInstant(ctx.today, 0, ctx.tz) : localInstant(ctx.today, afternoonFrom, ctx.tz);
    const pings = await this.prisma.transportBusPing.findMany({
      where: { routeId: id, recordedAt: { gte: from } },
      orderBy: { recordedAt: 'asc' },
      select: { latitude: true, longitude: true, speedKmph: true, recordedAt: true },
      take: 5000,
    });
    const step = Math.max(1, Math.ceil(pings.length / 500));
    const trail = pings.filter((_, i) => i % step === 0 || i === pings.length - 1).map((p) => ({
      latitude: p.latitude, longitude: p.longitude, speedKmph: p.speedKmph != null ? Math.round(p.speedKmph) : null, recordedAt: p.recordedAt.toISOString(),
    }));

    const { students: _count, ...row } = b.row;
    return { ...row, stopList, students: studentRows, trail };
  }

  // -------------------------------------------------------------------------
  // Route and stop writes
  // -------------------------------------------------------------------------

  private async checkStaff(field: 'driverId' | 'attendantId', id: string | null | undefined) {
    if (!id) return;
    const e = await this.prisma.employee.findUnique({ where: { id }, select: { id: true, archivedAt: true, employmentStatus: true } });
    if (!e || e.archivedAt || e.employmentStatus === 'exited') throw fieldError(field, 'Choose a current staff member');
  }

  async saveRoute(id: string | null, dto: {
    code: string; name: string; area: string; campusId: string; vehicleId?: string | null; driverId?: string | null; attendantId?: string | null;
  }, user: AuthUser, req: Request) {
    const existing = id ? await this.getRoute(id) : null;
    const code = dto.code.trim().toUpperCase();
    const campus = await this.prisma.campus.findUnique({ where: { id: dto.campusId }, select: { id: true } });
    if (!campus) throw fieldError('campusId', 'Choose a campus');
    if (dto.driverId && dto.driverId === dto.attendantId) throw fieldError('attendantId', 'The attendant must be a different person');
    await this.checkStaff('driverId', dto.driverId);
    await this.checkStaff('attendantId', dto.attendantId);
    const clash = await this.prisma.transportRoute.findFirst({ where: { campusId: dto.campusId, code, ...(id ? { id: { not: id } } : {}) }, select: { id: true } });
    if (clash) throw fieldError('code', `Route ${code} already exists on this campus`);
    let vehicle: TransportVehicle | null = null;
    if (dto.vehicleId) {
      vehicle = await this.prisma.transportVehicle.findUnique({ where: { id: dto.vehicleId } });
      if (!vehicle || vehicle.status === 'retired') throw fieldError('vehicleId', 'Choose an active vehicle');
    }
    if (existing && existing.campusId !== dto.campusId) {
      const n = await this.prisma.studentTransport.count({ where: { routeId: existing.id } });
      if (n) throw fieldError('campusId', 'Students are assigned to this route; remove them before moving it to another campus');
    }
    const data = {
      campusId: dto.campusId,
      code,
      name: dto.name.trim(),
      vehicleLabel: vehicle?.busNo ?? '',
      vehicleNo: vehicle?.registrationNo ?? null,
      capacity: vehicle?.capacity ?? existing?.capacity ?? 40,
      driverId: dto.driverId || null,
      attendantId: dto.attendantId || null,
    };
    const route = existing
      ? await this.prisma.transportRoute.update({ where: { id: existing.id }, data })
      : await this.prisma.transportRoute.create({ data });
    await this.prisma.transportRouteProfile.upsert({
      where: { routeId: route.id },
      create: { routeId: route.id, area: dto.area.trim(), vehicleId: vehicle?.id ?? null },
      update: { area: dto.area.trim(), vehicleId: vehicle?.id ?? null },
    });
    await this.audit.record({
      user, req, action: existing ? 'update' : 'create', module: 'transport', entityType: 'route', entityId: route.id, campusId: route.campusId,
      description: `${existing ? 'Updated' : 'Created'} route ${code} · ${route.name}${vehicle ? ` (${vehicle.busNo})` : ''}`,
    });
    const full = await this.getRoute(route.id);
    const ctx = await this.context([full]);
    return { row: this.buildRow(full, ctx).row, created: !existing };
  }

  async deleteRoute(id: string, user: AuthUser, req: Request) {
    const route = await this.getRoute(id);
    const [students, events] = await Promise.all([
      this.prisma.studentTransport.count({ where: { routeId: id } }),
      this.prisma.transportBoardingEvent.count({ where: { routeId: id } }),
    ]);
    if (students || events) {
      throw conflict(`${route.code} has ${students ? plural(students, 'student') : 'boarding history'} — set it to Maintenance instead of deleting it`);
    }
    await this.prisma.$transaction([
      this.prisma.transportBusPing.deleteMany({ where: { routeId: id } }),
      this.prisma.transportRouteProfile.deleteMany({ where: { routeId: id } }),
      this.prisma.transportRoute.delete({ where: { id } }),
    ]);
    await this.audit.record({ user, req, action: 'delete', module: 'transport', entityType: 'route', entityId: id, campusId: route.campusId, description: `Deleted route ${route.code} · ${route.name}` });
    return route;
  }

  private stopTimes(dto: { pickupTime: string; dropTime?: string | null }) {
    if (timeToMinutes(dto.pickupTime) == null) throw fieldError('pickupTime', 'Choose the pickup time');
    if (dto.dropTime && timeToMinutes(dto.dropTime) == null) throw fieldError('dropTime', 'Use a time like 15:40');
  }

  async addStop(routeId: string, dto: { name: string; latitude: number; longitude: number; pickupTime: string; dropTime?: string | null }, user: AuthUser, req: Request) {
    const route = await this.getRoute(routeId);
    this.stopTimes(dto);
    const sequence = route.stops.reduce((m, s) => Math.max(m, s.sequence), 0) + 1;
    const stop = await this.prisma.routeStop.create({
      data: { routeId, name: dto.name.trim(), sequence, latitude: dto.latitude, longitude: dto.longitude, pickupTime: dto.pickupTime, dropTime: dto.dropTime || null },
    });
    await this.audit.record({ user, req, action: 'update', module: 'transport', entityType: 'route', entityId: routeId, campusId: route.campusId, description: `Added stop ${sequence}. ${stop.name} to ${route.code}` });
    return stop;
  }

  async updateStop(routeId: string, stopId: string, dto: { name: string; latitude: number; longitude: number; pickupTime: string; dropTime?: string | null }, user: AuthUser, req: Request) {
    const route = await this.getRoute(routeId);
    const stop = route.stops.find((s) => s.id === stopId);
    if (!stop) throw notFound('Stop');
    this.stopTimes(dto);
    const updated = await this.prisma.routeStop.update({
      where: { id: stopId },
      data: { name: dto.name.trim(), latitude: dto.latitude, longitude: dto.longitude, pickupTime: dto.pickupTime, dropTime: dto.dropTime || null },
    });
    await this.audit.record({ user, req, action: 'update', module: 'transport', entityType: 'route', entityId: routeId, campusId: route.campusId, description: `Updated stop ${updated.name} on ${route.code}` });
    return updated;
  }

  async deleteStop(routeId: string, stopId: string, user: AuthUser, req: Request) {
    const route = await this.getRoute(routeId);
    const stop = route.stops.find((s) => s.id === stopId);
    if (!stop) throw notFound('Stop');
    const assigned = await this.prisma.studentTransport.count({ where: { stopId } });
    if (assigned) throw conflict(`${plural(assigned, 'student is', 'students are')} assigned to ${stop.name}; move them to another stop first`);
    const rest = route.stops.filter((s) => s.id !== stopId).sort((a, b) => a.sequence - b.sequence);
    await this.prisma.$transaction([
      this.prisma.routeStop.delete({ where: { id: stopId } }),
      ...rest.map((s, i) => this.prisma.routeStop.update({ where: { id: s.id }, data: { sequence: i + 1 } })),
    ]);
    await this.audit.record({ user, req, action: 'update', module: 'transport', entityType: 'route', entityId: routeId, campusId: route.campusId, description: `Removed stop ${stop.name} from ${route.code}` });
    return stop;
  }

  async reorderStops(routeId: string, stopIds: string[], user: AuthUser, req: Request) {
    const route = await this.getRoute(routeId);
    const current = new Set(route.stops.map((s) => s.id));
    if (stopIds.length !== current.size || new Set(stopIds).size !== stopIds.length || stopIds.some((s) => !current.has(s))) {
      throw badRequest('The stop list has changed — reload the route and try again');
    }
    await this.prisma.$transaction(stopIds.map((sid, i) => this.prisma.routeStop.update({ where: { id: sid }, data: { sequence: i + 1 } })));
    await this.audit.record({ user, req, action: 'update', module: 'transport', entityType: 'route', entityId: routeId, campusId: route.campusId, description: `Reordered the stops of ${route.code}` });
  }

  async assignStudent(routeId: string, dto: { studentId: string; stopId: string; mode: string }, user: AuthUser, req: Request) {
    const route = await this.getRoute(routeId);
    const stop = route.stops.find((s) => s.id === dto.stopId);
    if (!stop) throw fieldError('stopId', 'Choose a stop on this route');
    const student = await this.prisma.student.findUnique({
      where: { id: dto.studentId },
      select: { id: true, fullName: true, admissionNo: true, campusId: true, status: true, transport: { include: { route: true } } },
    });
    if (!student || student.status !== 'active') throw fieldError('studentId', 'Choose a current student');
    if (student.campusId !== route.campusId) throw fieldError('studentId', `${student.fullName} studies at another campus`);
    const previous = student.transport?.route ?? null;
    if (previous?.id !== routeId) {
      const profile = await this.prisma.transportRouteProfile.findUnique({ where: { routeId } });
      const vehicle = profile?.vehicleId ? await this.prisma.transportVehicle.findUnique({ where: { id: profile.vehicleId } }) : null;
      if (vehicle) {
        const onRoute = await this.prisma.studentTransport.count({ where: { routeId, student: { status: 'active' } } });
        if (onRoute >= vehicle.capacity) throw fieldError('studentId', `${vehicle.busNo} is full (${onRoute}/${vehicle.capacity} seats)`);
      }
    }
    await this.prisma.studentTransport.upsert({
      where: { studentId: student.id },
      create: { studentId: student.id, routeId, stopId: stop.id },
      update: { routeId, stopId: stop.id, ...(previous?.id !== routeId ? { since: new Date() } : {}) },
    });
    await this.prisma.transportStudentMode.upsert({ where: { studentId: student.id }, create: { studentId: student.id, mode: dto.mode }, update: { mode: dto.mode } });
    const moved = previous && previous.id !== routeId ? ` (moved from ${previous.code})` : '';
    await this.audit.record({
      user, req, action: 'update', module: 'transport', entityType: 'student', entityId: student.id, campusId: route.campusId,
      description: `Assigned ${student.fullName} (${student.admissionNo}) to ${route.code}, stop ${stop.name}${moved}`,
    });
    return `${student.fullName} assigned to ${route.name} · ${stop.name}${moved}`;
  }

  async unassignStudent(routeId: string, studentId: string, user: AuthUser, req: Request) {
    const route = await this.getRoute(routeId);
    if (!isUuid(studentId)) throw notFound('Student');
    const link = await this.prisma.studentTransport.findUnique({ where: { studentId }, include: { student: { select: { fullName: true, admissionNo: true } } } });
    if (!link || link.routeId !== routeId) throw notFound('Student on this route');
    await this.prisma.$transaction([
      this.prisma.studentTransport.delete({ where: { studentId } }),
      this.prisma.transportStudentMode.deleteMany({ where: { studentId } }),
    ]);
    await this.audit.record({
      user, req, action: 'update', module: 'transport', entityType: 'student', entityId: studentId, campusId: route.campusId,
      description: `Removed ${link.student.fullName} (${link.student.admissionNo}) from ${route.code}`,
    });
    return `${link.student.fullName} removed from ${route.name}`;
  }

  // -------------------------------------------------------------------------
  // Run status and parent messages
  // -------------------------------------------------------------------------

  /** Parent accounts of the given students. */
  async guardianUserIds(studentIds: string[]): Promise<string[]> {
    if (!studentIds.length) return [];
    const links = await this.prisma.studentGuardian.findMany({ where: { studentId: { in: studentIds } }, select: { guardianId: true } });
    if (!links.length) return [];
    const users = await this.prisma.user.findMany({
      where: { parentId: { in: [...new Set(links.map((l) => l.guardianId))] }, status: 'active' },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  private async routeStudentIds(routeId: string) {
    const rows = await this.prisma.studentTransport.findMany({ where: { routeId, student: { status: 'active' } }, select: { studentId: true } });
    return rows.map((r) => r.studentId);
  }

  private async vehicleOf(routeId: string) {
    const profile = await this.prisma.transportRouteProfile.findUnique({ where: { routeId } });
    const vehicle = profile?.vehicleId ? await this.prisma.transportVehicle.findUnique({ where: { id: profile.vehicleId } }) : null;
    return { profile, vehicle };
  }

  async updateRun(id: string, dto: { runStatus: RunStatus; delayMinutes?: number; notifyParents?: boolean; etaText?: string; reason?: string }, user: AuthUser, req: Request) {
    const route = await this.getRoute(id);
    const key = RUN_KEY[dto.runStatus];
    const delayAllowed = dto.runStatus === 'Delayed' || dto.runStatus === 'En route';
    const delay = delayAllowed ? Math.round(dto.delayMinutes ?? 0) : 0;
    if (dto.runStatus === 'Delayed' && delay < 1) throw fieldError('delayMinutes', 'Enter how many minutes late');
    const { today } = await this.config.clock();
    const { vehicle } = await this.vehicleOf(id);
    const bus = busLabelOf(route, vehicle);
    await this.prisma.transportRoute.update({ where: { id }, data: { status: key } });
    const fields = {
      runDate: dbDate(today),
      delayMinutes: delay,
      etaText: delayAllowed ? dto.etaText?.trim() || null : null,
      statusReason: dto.reason?.trim() || null,
      statusUpdatedAt: new Date(),
      statusUpdatedBy: user.fullName,
    };
    await this.prisma.transportRouteProfile.upsert({ where: { routeId: id }, create: { routeId: id, ...fields }, update: fields });

    let notified = 0;
    const tellParents = dto.notifyParents && (dto.runStatus === 'Delayed' || dto.runStatus === 'Maintenance' || delay > 0);
    if (tellParents) {
      const recipients = await this.guardianUserIds(await this.routeStudentIds(id));
      const reason = dto.reason?.trim();
      const notice = dto.runStatus === 'Maintenance'
        ? {
          title: `${bus} (${route.name}) is not running today`,
          body: `${reason ? `${reason}. ` : ''}Please arrange to bring your child to school. We will tell you as soon as the bus is back in service.`,
        }
        : {
          title: `${bus} is running about ${delay} minutes late`,
          body: `${reason ? `${reason}. ` : ''}Pickup times at every stop on ${route.name} move by about ${delay} minutes.${fields.etaText ? ` ETA ${fields.etaText}.` : ''}`,
        };
      await this.notifications.notifyUsers(recipients, {
        category: 'Attention', topic: 'transport', module: 'transport', ...notice, route: PARENT_ROUTE, campusId: route.campusId, deliver: true,
      });
      notified = recipients.length;
    }
    await this.audit.record({
      user, req, action: 'update', module: 'transport', entityType: 'route', entityId: id, campusId: route.campusId,
      description: `Set ${route.code} run to ${dto.runStatus}${delay ? ` (+${delay} min)` : ''}${dto.reason ? ` — ${dto.reason}` : ''}${tellParents ? ` · ${notified} parents notified` : ''}`,
    });
    return `${bus} is now ${dto.runStatus}${delay ? ` (+${delay} min)` : ''}${tellParents ? ` · ${plural(notified, 'parent')} notified` : ''}`;
  }

  async notifyRoute(id: string, message: string, user: AuthUser, req: Request) {
    const route = await this.getRoute(id);
    const { vehicle } = await this.vehicleOf(id);
    const recipients = await this.guardianUserIds(await this.routeStudentIds(id));
    if (!recipients.length) throw badRequest('No parent accounts are linked to the students on this route');
    await this.notifications.notifyUsers(recipients, {
      category: 'Attention', topic: 'transport', module: 'transport',
      title: `${busLabelOf(route, vehicle)} · ${route.name}`, body: message.trim(), route: PARENT_ROUTE, campusId: route.campusId, deliver: true,
    });
    await this.audit.record({
      user, req, action: 'publish', module: 'transport', entityType: 'route', entityId: id, campusId: route.campusId,
      description: `Messaged ${plural(recipients.length, 'parent')} on ${route.code}: ${message.trim().slice(0, 160)}`,
    });
    return `Message sent to ${plural(recipients.length, 'parent')}`;
  }

  // -------------------------------------------------------------------------
  // Boarding / de-boarding
  // -------------------------------------------------------------------------

  async recordBoarding(dto: {
    studentId: string; routeId: string; eventType: 'boarded' | 'deboarded'; method?: string; stopId?: string; latitude?: number; longitude?: number; occurredAt?: string;
  }, user: AuthUser, req: Request) {
    const route = await this.getRoute(dto.routeId);
    const clock = await this.config.clock();
    const { profile, vehicle } = await this.vehicleOf(route.id);
    const run = this.effectiveRun(route, profile, clock.today);
    const bus = busLabelOf(route, vehicle);
    if (run.key === 'maintenance') throw badRequest(`${bus} is out of service — set the run status before confirming boarding`);
    const link = await this.prisma.studentTransport.findUnique({
      where: { studentId: dto.studentId },
      include: { student: { select: { fullName: true, firstName: true, status: true } }, stop: true },
    });
    if (!link || link.routeId !== route.id || link.student.status !== 'active') throw fieldError('studentId', 'This student is not assigned to this route');
    const last = await this.prisma.transportBoardingEvent.findFirst({
      where: { routeId: route.id, studentId: dto.studentId, runDate: dbDate(clock.today), session: clock.session },
      orderBy: { occurredAt: 'desc' },
    });
    const name = link.student.fullName;
    if (dto.eventType === 'boarded' && last?.eventType === 'boarded') throw conflict(`${name} is already marked on the bus`);
    if (dto.eventType === 'deboarded' && last?.eventType !== 'boarded') throw badRequest(`${name} has not boarded this run yet`);
    let occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : clock.now;
    if (Number.isNaN(occurredAt.getTime()) || occurredAt > clock.now || dateKey(occurredAt, clock.tz) !== clock.today) occurredAt = clock.now;
    if (last && occurredAt < last.occurredAt) occurredAt = clock.now;
    const stopId = dto.stopId && route.stops.some((s) => s.id === dto.stopId) ? dto.stopId : link.stopId;
    const stop = route.stops.find((s) => s.id === stopId) ?? null;
    const event = await this.prisma.transportBoardingEvent.create({
      data: {
        routeId: route.id, studentId: dto.studentId, runDate: dbDate(clock.today), session: clock.session, eventType: dto.eventType,
        method: dto.method?.trim() || 'Manual', stopId, latitude: dto.latitude ?? null, longitude: dto.longitude ?? null, occurredAt,
        recordedById: user.id, recordedByName: user.fullName,
      },
    });

    // Parents hear about every confirmation.
    const atCampus = dto.eventType === 'deboarded' && clock.session === 'morning';
    const where = dto.eventType === 'boarded'
      ? (clock.session === 'morning' ? (stop ? ` at ${stop.name}` : '') : ' at school')
      : atCampus ? ' at school' : stop ? ` at ${stop.name}` : '';
    await this.notifications.notifyGuardians(dto.studentId, {
      category: 'Information', topic: 'transport', module: 'transport',
      title: dto.eventType === 'boarded' ? `${link.student.firstName} boarded ${bus}` : `${link.student.firstName} got off ${bus}`,
      body: `${dto.eventType === 'boarded' ? 'Boarded' : 'Got off'}${where} at ${hhmm(occurredAt, clock.tz)} · ${route.name}`,
      route: PARENT_ROUTE, campusId: route.campusId, deliver: true,
    });
    await this.prisma.transportBoardingEvent.update({ where: { id: event.id }, data: { parentNotifiedAt: new Date() } });

    await this.autoRunFromBoarding(route.id, run, clock);
    await this.audit.record({
      user, req, action: 'create', module: 'transport', entityType: 'boarding', entityId: event.id, campusId: route.campusId,
      description: `${name} ${dto.eventType === 'boarded' ? 'boarded' : 'de-boarded'} ${bus} (${clock.session} run, ${event.method})`,
    });
    return {
      data: { id: event.id, studentId: dto.studentId, routeId: route.id, eventType: event.eventType, session: event.session, occurredAt: event.occurredAt.toISOString() },
      message: `${name} marked as ${dto.eventType === 'boarded' ? 'boarded' : 'de-boarded'} · parents notified`,
    };
  }

  /**
   * Run status from boarding: the first child boarding starts a scheduled morning run and the first drop-off
   * shows the afternoon bus has left; once everyone who boarded is off again the run has arrived
   * (At campus in the morning, Completed in the afternoon).
   */
  private async autoRunFromBoarding(routeId: string, run: RunState, clock: { today: string; session: RunSession }) {
    if (run.key === 'maintenance' || run.key === 'completed') return;
    const events = await this.prisma.transportBoardingEvent.findMany({
      where: { routeId, runDate: dbDate(clock.today), session: clock.session }, orderBy: { occurredAt: 'asc' },
    });
    const states = this.studentStates(events);
    const onboard = [...states.values()].filter((s) => s.lastEvent === 'boarded').length;
    const anyOff = [...states.values()].some((s) => s.deboardedAt);
    let next: string | null = null;
    if (clock.session === 'morning') {
      if (run.key === 'scheduled' && onboard > 0) next = 'en_route';
      else if (run.moving && onboard === 0 && states.size > 0) next = 'at_campus';
    } else if (onboard === 0 && states.size > 0 && anyOff) {
      next = 'completed';
    } else if (!run.moving && onboard > 0 && anyOff) {
      next = 'en_route';
    }
    if (!next || next === run.key) return;
    await this.setRunAuto(routeId, next, clock.today, 'Boarding');
  }

  private async setRunAuto(routeId: string, key: string, today: string, by: string) {
    await this.prisma.transportRoute.update({ where: { id: routeId }, data: { status: key } });
    const keepDelay = key === 'en_route' || key === 'delayed';
    const existing = await this.prisma.transportRouteProfile.findUnique({ where: { routeId } });
    const sameDay = existing?.runDate?.toISOString().slice(0, 10) === today;
    const fields = {
      runDate: dbDate(today),
      statusUpdatedAt: new Date(),
      statusUpdatedBy: by,
      ...(keepDelay && sameDay ? {} : { delayMinutes: 0, etaText: null }),
      ...(sameDay ? {} : { statusReason: null }),
    };
    await this.prisma.transportRouteProfile.upsert({ where: { routeId }, create: { routeId, ...fields }, update: fields });
  }

  /** GET /transport/boarding/summary — reconciliation of the current run by route. */
  async boardingSummary(campusId: string | undefined) {
    const routes = await this.loadRoutes({ isActive: true, ...(campusId ? { campusId } : {}) });
    const ctx = await this.context(routes);
    const out = routes.map((r) => {
      const b = this.buildRow(r, ctx);
      const expectedIds = b.links.filter((l) => this.expectedIn(ctx.modes.get(l.studentId), ctx.session)).map((l) => l.studentId);
      let boarded = 0;
      let deboarded = 0;
      let stillOnboard = 0;
      for (const sid of b.links.map((l) => l.studentId)) {
        const s = b.states.get(sid);
        if (s?.boardedAt) boarded++;
        if (s?.lastEvent === 'deboarded') deboarded++;
        if (s?.lastEvent === 'boarded') stillOnboard++;
      }
      const expected = expectedIds.length;
      const notBoarded = Math.max(0, expectedIds.filter((sid) => !b.states.get(sid)?.boardedAt).length);
      const finished = this.finished(b.run, ctx.session);
      const state = b.run.key === 'maintenance' || expected === 0 ? 'Not running'
        : stillOnboard > 0 ? (finished ? 'Exception' : 'In progress')
          : boarded === 0 ? (finished ? 'Not boarded' : b.run.key === 'scheduled' ? 'Not running' : 'In progress')
            : notBoarded > 0 ? (finished ? 'Not boarded' : 'In progress')
              : 'Matched';
      return {
        row: {
          id: r.id, code: r.code, name: r.name, area: b.row.area, busNo: b.row.busNo, runStatus: b.row.runStatus, attendantName: b.row.attendantName,
          expected, boarded, deboarded, notBoarded, stillOnboard, state,
        },
        maintenance: b.run.key === 'maintenance',
        students: b.links.length,
        firstDrop: Math.min(...b.stops.map((s) => timeToMinutes(s.dropTime) ?? Infinity)),
      };
    });
    const running = out.filter((o) => !o.maintenance);
    const firstDrop = Math.min(...running.map((o) => o.firstDrop));
    return {
      boarded: running.reduce((a, o) => a + o.row.boarded, 0),
      deboarded: running.reduce((a, o) => a + o.row.deboarded, 0),
      stillOnboard: running.reduce((a, o) => a + o.row.stillOnboard, 0),
      notBoarded: running.reduce((a, o) => a + o.row.notBoarded, 0),
      expected: running.reduce((a, o) => a + o.row.expected, 0),
      maintenanceStudents: out.filter((o) => o.maintenance).reduce((a, o) => a + o.students, 0),
      afternoonRun: Number.isFinite(firstDrop) ? minutesToTime(firstDrop) : null,
      session: ctx.session,
      routes: out.map((o) => o.row),
    };
  }

  // -------------------------------------------------------------------------
  // Bus positions (mounted tracker, attendant app or Traccar)
  // -------------------------------------------------------------------------

  /** Records bus positions for routes and updates their live state, passed stops, deviation and automatic run status. */
  async recordBusPings(routeIds: string[], points: BusPoint[], meta: { source: string; vehicleId?: string | null; deviceId?: string | null }) {
    if (!routeIds.length || !points.length) return 0;
    const sorted = [...points].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
    const clock = await this.config.clock();
    let routes = await this.prisma.transportRoute.findMany({ where: { id: { in: routeIds } }, include: { stops: true } });
    if (!routes.length) return 0;
    const profiles = new Map((await this.prisma.transportRouteProfile.findMany({ where: { routeId: { in: routes.map((r) => r.id) } } })).map((p) => [p.routeId, p]));
    // A vehicle shared by several routes reports for the one that is running (if any).
    if (routes.length > 1) {
      const running = routes.filter((r) => this.effectiveRun(r, profiles.get(r.id), clock.today).moving);
      if (running.length) routes = running;
    }
    await this.prisma.transportBusPing.createMany({
      data: routes.flatMap((r) => sorted.map((p) => ({
        routeId: r.id, vehicleId: meta.vehicleId ?? null, deviceId: meta.deviceId ?? null, source: meta.source,
        latitude: p.latitude, longitude: p.longitude, speedKmph: p.speedKmph, heading: p.heading, accuracy: p.accuracy, recordedAt: p.recordedAt,
      }))),
    });
    const campuses = new Map((await this.config.campuses()).map((c) => [c.id, c]));
    const deviationKm = await this.config.deviationKm();
    for (const route of routes) {
      try {
        await this.applyBusPings(route, profiles.get(route.id) ?? null, sorted, campuses.get(route.campusId), deviationKm, meta.source, clock);
      } catch (err) {
        this.log.warn(`Bus position update failed for ${route.code}: ${(err as Error).message}`);
      }
    }
    return sorted.length;
  }

  private async applyBusPings(
    route: RouteWithStops, profile: TransportRouteProfile | null, points: BusPoint[], campus: CampusGeo | undefined, deviationKm: number, source: string,
    clock: { today: string; session: RunSession; minutes: number; tz: string; now: Date },
  ) {
    const latest = points[points.length - 1];
    const isNewer = !profile?.lastPingAt || latest.recordedAt > profile.lastPingAt;
    const stops = [...route.stops].sort((a, b) => a.sequence - b.sequence);
    const located = stops.filter(hasPoint);
    const campusPt = campus && hasPoint(campus) ? campus : null;
    const planned: LatLng[] = clock.session === 'morning' ? [...located, ...(campusPt ? [campusPt] : [])] : [...(campusPt ? [campusPt] : []), ...located];

    // Stops passed during the current run.
    const key = this.doneKey(clock.today, clock.session);
    const doneAll = { ...((profile?.doneStops as Record<string, string[]> | null) ?? {}) };
    for (const k of Object.keys(doneAll)) if (!k.startsWith(clock.today)) delete doneAll[k];
    const done = new Set(doneAll[key] ?? []);
    for (const p of points) {
      if (dateKey(p.recordedAt, clock.tz) !== clock.today) continue;
      for (const s of located) if (distanceM(p, s) <= STOP_RADIUS_M) done.add(s.id);
    }
    doneAll[key] = [...done];

    const run = this.effectiveRun(route, profile, clock.today);
    const deviation = planned.length ? distanceToPathM(latest, planned) : null;
    const data: Prisma.TransportRouteProfileUncheckedUpdateInput = { doneStops: doneAll };
    if (isNewer) {
      Object.assign(data, {
        lastLatitude: latest.latitude, lastLongitude: latest.longitude, lastSpeedKmph: latest.speedKmph, lastHeading: latest.heading,
        lastPingAt: latest.recordedAt, lastPingSource: source, deviationMetres: deviation != null ? Math.round(deviation) : null,
      });
    }
    await this.prisma.transportRouteProfile.upsert({
      where: { routeId: route.id },
      create: { ...(data as Prisma.TransportRouteProfileUncheckedCreateInput), routeId: route.id },
      update: data,
    });
    if (!isNewer || clock.now.getTime() - latest.recordedAt.getTime() > LIVE_PING_MS) return;

    // Automatic run status from the position.
    const inside = campusPt ? distanceM(latest, campusPt) <= (campus!.radiusM || 250) : false;
    const moving = (latest.speedKmph ?? 0) >= 5;
    const firstTime = clock.session === 'morning'
      ? Math.min(...stops.map((s) => timeToMinutes(s.pickupTime) ?? Infinity))
      : Math.min(...stops.map((s) => timeToMinutes(s.dropTime) ?? Infinity));
    const inWindow = !Number.isFinite(firstTime) || clock.minutes >= firstTime - 90;
    let next: string | null = null;
    if (run.key !== 'maintenance') {
      if (clock.session === 'morning') {
        if (run.key === 'scheduled' && moving && !inside && inWindow) next = 'en_route';
        else if (run.moving && inside) next = 'at_campus';
      } else {
        if ((run.key === 'scheduled' || run.key === 'at_campus') && moving && !inside && inWindow) next = 'en_route';
        else if (run.moving && located.length > 0 && located.every((s) => done.has(s.id))) next = 'completed';
      }
    }
    if (next && next !== run.key) await this.setRunAuto(route.id, next, clock.today, 'GPS');

    // Deviation alert to transport managers (at most every 15 minutes per route).
    const stillMoving = next ? next === 'en_route' : run.moving;
    if (stillMoving && deviation != null && deviation > deviationKm * 1000 && (!profile?.deviationAlertAt || clock.now.getTime() - profile.deviationAlertAt.getTime() > 15 * 60_000)) {
      const { vehicle } = await this.vehicleOf(route.id);
      const bus = busLabelOf(route, vehicle);
      await this.notifications.notifyPermission('transport.manage', {
        category: 'Critical', topic: 'transport', module: 'transport',
        title: `${bus} is ${round(deviation / 1000, 1)} km off its planned route`,
        body: `${route.code} · ${route.name} · position at ${hhmm(latest.recordedAt, clock.tz)}${latest.speedKmph != null ? `, ${Math.round(latest.speedKmph)} km/h` : ''}`,
        route: `/bus-tracking?route=${encodeURIComponent(route.code)}`, campusId: route.campusId,
      });
      await this.prisma.transportRouteProfile.update({ where: { routeId: route.id }, data: { deviationAlertAt: clock.now } });
    }
  }

  // -------------------------------------------------------------------------
  // Vehicles
  // -------------------------------------------------------------------------

  async vehicles(campusId: string | undefined) {
    const vehicles = await this.prisma.transportVehicle.findMany({
      where: { status: { not: 'retired' }, ...(campusId ? { campusId } : {}) },
      orderBy: { busNo: 'asc' },
    });
    const profiles = vehicles.length ? await this.prisma.transportRouteProfile.findMany({ where: { vehicleId: { in: vehicles.map((v) => v.id) } }, select: { routeId: true, vehicleId: true } }) : [];
    const routes = profiles.length ? await this.prisma.transportRoute.findMany({ where: { id: { in: profiles.map((p) => p.routeId) }, isActive: true }, select: { id: true, code: true } }) : [];
    const codeOf = new Map(routes.map((r) => [r.id, r.code]));
    return vehicles
      .sort((a, b) => a.busNo.localeCompare(b.busNo, 'en', { numeric: true }))
      .map((v) => ({
        id: v.id, busNo: v.busNo, registrationNo: v.registrationNo, capacity: v.capacity, status: v.status, campusId: v.campusId, gpsDeviceId: v.gpsDeviceId,
        routeCode: profiles.filter((p) => p.vehicleId === v.id).map((p) => codeOf.get(p.routeId)).filter(Boolean).sort()[0] ?? null,
      }));
  }

  async saveVehicle(id: string | null, dto: { campusId: string; busNo: string; registrationNo: string; capacity: number; status?: string; gpsDeviceId?: string | null }, user: AuthUser, req: Request) {
    const existing = id ? (isUuid(id) ? await this.prisma.transportVehicle.findUnique({ where: { id } }) : null) : null;
    if (id && !existing) throw notFound('Vehicle');
    const registrationNo = dto.registrationNo.trim().toUpperCase().replace(/\s+/g, ' ');
    const clash = await this.prisma.transportVehicle.findFirst({ where: { registrationNo, ...(id ? { id: { not: id } } : {}) }, select: { busNo: true } });
    if (clash) throw fieldError('registrationNo', `${registrationNo} is already registered as ${clash.busNo}`);
    if (!(await this.prisma.campus.findUnique({ where: { id: dto.campusId }, select: { id: true } }))) throw fieldError('campusId', 'Choose a campus');
    const gpsDeviceId = dto.gpsDeviceId === undefined ? existing?.gpsDeviceId ?? null : dto.gpsDeviceId || null;
    if (gpsDeviceId && gpsDeviceId !== existing?.gpsDeviceId) {
      const device = isUuid(gpsDeviceId) ? await this.prisma.trackingDevice.findUnique({ where: { id: gpsDeviceId } }) : null;
      if (!device) throw fieldError('gpsDeviceId', 'Choose a registered GPS device');
      if (device.status !== 'available') throw fieldError('gpsDeviceId', `${device.deviceCode} is ${device.status}; choose an available device`);
    }
    const data = { campusId: dto.campusId, busNo: dto.busNo.trim(), registrationNo, capacity: dto.capacity, status: dto.status ?? existing?.status ?? 'active', gpsDeviceId };
    const vehicle = existing ? await this.prisma.transportVehicle.update({ where: { id: existing.id }, data }) : await this.prisma.transportVehicle.create({ data });
    // A tracker mounted on a bus is in use; the one taken off becomes available again.
    if (existing?.gpsDeviceId && existing.gpsDeviceId !== gpsDeviceId) {
      await this.prisma.trackingDevice.updateMany({ where: { id: existing.gpsDeviceId, status: 'assigned' }, data: { status: 'available', statusReason: null } });
    }
    if (gpsDeviceId && gpsDeviceId !== existing?.gpsDeviceId) {
      await this.prisma.trackingDevice.update({ where: { id: gpsDeviceId }, data: { status: 'assigned', statusReason: `Mounted on ${vehicle.busNo}` } });
    }
    // Keep the core route record's vehicle label in step.
    const profiles = await this.prisma.transportRouteProfile.findMany({ where: { vehicleId: vehicle.id }, select: { routeId: true } });
    if (profiles.length) {
      await this.prisma.transportRoute.updateMany({
        where: { id: { in: profiles.map((p) => p.routeId) } },
        data: { vehicleLabel: vehicle.busNo, vehicleNo: vehicle.registrationNo, capacity: vehicle.capacity },
      });
    }
    await this.audit.record({
      user, req, action: existing ? 'update' : 'create', module: 'transport', entityType: 'vehicle', entityId: vehicle.id, campusId: vehicle.campusId,
      description: `${existing ? 'Updated' : 'Added'} vehicle ${vehicle.busNo} (${vehicle.registrationNo})`,
    });
    return vehicle;
  }

  async deleteVehicle(id: string, user: AuthUser, req: Request) {
    const vehicle = isUuid(id) ? await this.prisma.transportVehicle.findUnique({ where: { id } }) : null;
    if (!vehicle) throw notFound('Vehicle');
    const inUse = await this.prisma.transportRouteProfile.count({ where: { vehicleId: id } });
    if (inUse) throw conflict(`${vehicle.busNo} is used by ${plural(inUse, 'route')}; assign another vehicle first`);
    await this.prisma.transportVehicle.delete({ where: { id } });
    if (vehicle.gpsDeviceId) {
      await this.prisma.trackingDevice.updateMany({ where: { id: vehicle.gpsDeviceId, status: 'assigned' }, data: { status: 'available', statusReason: null } });
    }
    await this.audit.record({ user, req, action: 'delete', module: 'transport', entityType: 'vehicle', entityId: id, campusId: vehicle.campusId, description: `Removed vehicle ${vehicle.busNo} (${vehicle.registrationNo})` });
    return vehicle;
  }

  /** Routes that report positions from a GPS device mounted on their vehicle. */
  async routesForDevice(deviceId: string): Promise<{ vehicleId: string; routeIds: string[] } | null> {
    const vehicle = await this.prisma.transportVehicle.findUnique({ where: { gpsDeviceId: deviceId }, select: { id: true } });
    if (!vehicle) return null;
    const profiles = await this.prisma.transportRouteProfile.findMany({ where: { vehicleId: vehicle.id }, select: { routeId: true } });
    const routes = await this.prisma.transportRoute.findMany({ where: { id: { in: profiles.map((p) => p.routeId) }, isActive: true }, select: { id: true } });
    return { vehicleId: vehicle.id, routeIds: routes.map((r) => r.id) };
  }

  // -------------------------------------------------------------------------
  // For other modules (family portal, Student 360, location status)
  // -------------------------------------------------------------------------

  /**
   * A student's bus today: route, vehicle, staff, stop, run state, live bus position and today's boarding events.
   * Returns null when the student has no route. Used by the family portal.
   */
  async studentBus(studentId: string) {
    if (!isUuid(studentId)) return null;
    const link = await this.prisma.studentTransport.findUnique({ where: { studentId }, include: { stop: true } });
    if (!link) return null;
    const route = await this.prisma.transportRoute.findUnique({ where: { id: link.routeId }, include: { stops: true } });
    if (!route) return null;
    const ctx = await this.context([route]);
    const b = this.buildRow(route, ctx);
    const events = await this.prisma.transportBoardingEvent.findMany({
      where: { studentId, runDate: dbDate(ctx.today) }, orderBy: { occurredAt: 'asc' },
    });
    return {
      routeId: route.id,
      routeCode: route.code,
      routeName: route.name,
      area: b.row.area,
      busNo: b.row.busNo,
      registrationNo: b.row.registrationNo,
      runStatus: b.row.runStatus,
      delayMinutes: b.row.delayMinutes,
      eta: b.row.eta,
      driver: b.row.driverName,
      driverPhone: b.row.driverPhone,
      attendant: b.row.attendantName,
      stopId: link.stopId,
      stopName: link.stop?.name ?? null,
      pickupTime: link.stop?.pickupTime ?? null,
      dropTime: link.stop?.dropTime ?? null,
      mode: ctx.modes.get(studentId) ?? 'both',
      busLocation: b.row.location ? { latitude: b.row.location.latitude, longitude: b.row.location.longitude, recordedAt: b.row.location.recordedAt } : null,
      boardingToday: events.map((e) => ({ type: e.eventType, at: e.occurredAt.toISOString(), session: e.session, method: e.method, routeId: e.routeId })),
      alerts: b.row.alerts,
    };
  }

  /**
   * The student's bus right now: whether they are marked onboard in the current run, whether the run is
   * out on the road, and the live bus position. Null when the student has no route.
   */
  async busState(studentId: string): Promise<{
    routeId: string; routeName: string; label: string; boarded: boolean; runMoving: boolean; busPosition: LatLng | null; stop: LatLng & { name: string } | null;
  } | null> {
    const link = await this.prisma.studentTransport.findUnique({ where: { studentId }, include: { route: true, stop: true } });
    if (!link) return null;
    const clock = await this.config.clock();
    const [last, profile] = await Promise.all([
      this.prisma.transportBoardingEvent.findFirst({ where: { studentId, routeId: link.routeId, runDate: dbDate(clock.today), session: clock.session }, orderBy: { occurredAt: 'desc' } }),
      this.prisma.transportRouteProfile.findUnique({ where: { routeId: link.routeId } }),
    ]);
    const run = this.effectiveRun(link.route, profile, clock.today);
    const vehicle = profile?.vehicleId ? await this.prisma.transportVehicle.findUnique({ where: { id: profile.vehicleId }, select: { busNo: true } }) : null;
    const fresh = !!profile?.lastPingAt && clock.now.getTime() - profile.lastPingAt.getTime() <= 5 * 60_000;
    return {
      routeId: link.routeId,
      routeName: link.route.name,
      label: busLabelOf(link.route, vehicle),
      boarded: last?.eventType === 'boarded',
      runMoving: run.moving,
      busPosition: fresh && profile?.lastLatitude != null && profile.lastLongitude != null ? { latitude: profile.lastLatitude, longitude: profile.lastLongitude } : null,
      stop: link.stop && hasPoint(link.stop) ? { name: link.stop.name, latitude: link.stop.latitude, longitude: link.stop.longitude } : null,
    };
  }
}
