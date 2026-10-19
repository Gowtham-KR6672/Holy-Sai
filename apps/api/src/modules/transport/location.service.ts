import { Injectable } from '@nestjs/common';
import type { Prisma, TrackingStudentState } from '@prisma/client';
import type { Request } from 'express';
import { type AuthUser, can } from '../../common/auth-user';
import { paged } from '../../common/envelope';
import { badRequest, forbidden, notFound } from '../../common/errors';
import { pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { campusParam, distanceM, gradeLabel, hasPoint, isUuid, type LatLng, localInstant, round, timeToMinutes } from './geo';
import { type CampusGeo, gpsStatusOf, TransportConfig } from './transport-config.service';
import { TransportService } from './transport.service';

export type LocationStatus = 'at_school' | 'in_transit' | 'at_home' | 'on_trip' | 'unknown';
export const LOCATION_LABEL: Record<LocationStatus, string> = {
  at_school: 'At school',
  in_transit: 'In transit',
  at_home: 'At home',
  on_trip: 'On a school trip',
  unknown: 'Location unknown',
};

export type DisplayStatus = 'Tracking Active' | 'Offline' | 'No Location Yet' | 'Tracking Paused' | 'Tracking Disabled';
const DISPLAY_RANK: Record<DisplayStatus, number> = { 'Tracking Active': 0, Offline: 1, 'No Location Yet': 2, 'Tracking Paused': 3, 'Tracking Disabled': 4 };

/** A location fix from a device, the attendant app or an integration. Speed in metres per second. */
export interface DevicePoint {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  batteryPct: number | null;
  recordedAt: Date;
}

export interface TrackingListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  campusId?: string;
  classId?: string;
  sectionId?: string;
  status?: string;
  locationStatus?: string;
}

const STUDENT_SELECT = {
  id: true,
  fullName: true,
  admissionNo: true,
  campusId: true,
  sectionId: true,
  photoUrl: true,
  status: true,
  trackingStatus: true,
  trackingConsentAt: true,
  section: { select: { name: true, classId: true, class: { select: { name: true, gradeLevel: true } } } },
  campus: { select: { name: true, latitude: true, longitude: true, radiusM: true } },
} satisfies Prisma.StudentSelect;
type StudentPick = Prisma.StudentGetPayload<{ select: typeof STUDENT_SELECT }>;
type AssignmentWithDevice = Prisma.TrackingAssignmentGetPayload<{ include: { device: true } }>;

/** Home and bus stop are "home" within this distance. */
const HOME_RADIUS_M = 250;
/** A child within this distance of their running bus is on it. */
const ON_BUS_RADIUS_M = 300;
/** Faster than this (m/s, ~14 km/h) a child is travelling. */
const MOVING_SPEED = 4;
/** Polling screens re-audit the same view at most this often. */
const VIEW_AUDIT_WINDOW_MS = 5 * 60_000;

const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Student locations: current location and history views (each one audited as a sensitive read), the
 * tracking list and map, tracking on/pause/off, and recording of location fixes with the derived status
 * (at school / in transit / at home / on a trip). The family portal reuses current() and history().
 */
@Injectable()
export class LocationService {
  private viewed = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly config: TransportConfig,
    private readonly transport: TransportService,
  ) {}

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------

  /** Students whose location this user may see: any (read_all / manage), their classes (read_assigned) or their children. */
  async trackingWhere(user: AuthUser, requestedCampus?: string | null): Promise<Prisma.StudentWhereInput> {
    const campusId = campusParam(requestedCampus);
    if (can(user, 'tracking.read_all', 'tracking.manage')) {
      if (user.scope === 'school') {
        const c = this.scope.campus(user, campusId);
        return c ? { campusId: c } : {};
      }
      return this.scope.studentWhere(user, campusId);
    }
    if (can(user, 'tracking.read_assigned')) {
      return { sectionId: { in: await this.scope.teacherSectionIds(user) }, ...(campusId ? { campusId } : {}) };
    }
    if (can(user, 'tracking.read_own_children')) return { id: { in: await this.scope.familyStudentIds(user) } };
    throw forbidden('Student locations are not available for your role');
  }

  async assertCanView(user: AuthUser, studentId: string) {
    if (!isUuid(studentId)) throw notFound('Student');
    const where = await this.trackingWhere(user);
    const n = await this.prisma.student.count({ where: { AND: [where, { id: studentId }] } });
    if (n === 0) {
      const exists = await this.prisma.student.count({ where: { id: studentId } });
      throw exists ? forbidden('This student is outside your access') : notFound('Student');
    }
  }

  /** Records a sensitive view in the audit trail, once per user and subject per five minutes for polling screens. */
  private async auditView(user: Pick<AuthUser, 'id' | 'fullName' | 'roleKey'>, key: string, input: { entityType: string; entityId?: string; description: string; campusId?: string | null; req?: Request }) {
    const k = `${user.id}|${key}`;
    const last = this.viewed.get(k);
    if (last && Date.now() - last < VIEW_AUDIT_WINDOW_MS) return;
    this.viewed.set(k, Date.now());
    if (this.viewed.size > 5000) {
      const cutoff = Date.now() - VIEW_AUDIT_WINDOW_MS;
      for (const [kk, t] of this.viewed) if (t < cutoff) this.viewed.delete(kk);
    }
    await this.audit.record({ user, action: 'view', module: 'tracking', sensitive: true, ...input });
  }

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------

  private async activeAssignments(studentIds: string[]) {
    if (!studentIds.length) return new Map<string, AssignmentWithDevice>();
    const rows = await this.prisma.trackingAssignment.findMany({
      where: { studentId: { in: studentIds }, status: 'active' },
      include: { device: true },
      orderBy: { assignedAt: 'desc' },
    });
    const map = new Map<string, AssignmentWithDevice>();
    for (const r of rows) if (!map.has(r.studentId)) map.set(r.studentId, r);
    return map;
  }

  private async states(studentIds: string[]) {
    if (!studentIds.length) return new Map<string, TrackingStudentState>();
    const rows = await this.prisma.trackingStudentState.findMany({ where: { studentId: { in: studentIds } } });
    return new Map(rows.map((r) => [r.studentId, r]));
  }

  private buildRow(s: StudentPick, state: TrackingStudentState | undefined, a: AssignmentWithDevice | undefined, staleMs: number, now: number) {
    const enabled = s.trackingStatus !== 'disabled';
    const visible = enabled && !!state?.recordedAt && state.latitude != null && state.longitude != null;
    const recordedAt = visible ? state!.recordedAt! : null;
    const isStale = visible ? s.trackingStatus === 'paused' || now - recordedAt!.getTime() > staleMs : false;
    const displayStatus: DisplayStatus = s.trackingStatus === 'disabled' ? 'Tracking Disabled'
      : s.trackingStatus === 'paused' ? 'Tracking Paused'
        : !visible ? 'No Location Yet'
          : isStale ? 'Offline' : 'Tracking Active';
    const locationStatus = visible ? ((state!.locationStatus as LocationStatus | null) ?? 'unknown') : null;
    const device = a?.device ?? null;
    return {
      studentId: s.id,
      fullName: s.fullName,
      admissionNo: s.admissionNo,
      grade: gradeLabel(s.section.class.name),
      section: s.section.name,
      gradeLevel: s.section.class.gradeLevel,
      classId: s.section.classId,
      sectionId: s.sectionId,
      campusId: s.campusId,
      campusName: s.campus.name,
      campusLatitude: s.campus.latitude,
      campusLongitude: s.campus.longitude,
      campusRadiusM: s.campus.radiusM,
      photoUrl: s.photoUrl,
      trackingStatus: s.trackingStatus as 'active' | 'paused' | 'disabled',
      trackingEnabled: enabled,
      consentAt: s.trackingConsentAt?.toISOString() ?? null,
      displayStatus,
      latitude: visible ? state!.latitude : null,
      longitude: visible ? state!.longitude : null,
      accuracy: visible ? state!.accuracy : null,
      speed: visible ? state!.speed : null,
      batteryPct: device ? device.batteryPct : visible ? state!.batteryPct : null,
      recordedAt: recordedAt?.toISOString() ?? null,
      isStale,
      locationStatus,
      locationStatusLabel: locationStatus ? LOCATION_LABEL[locationStatus] : 'No location yet',
      placeLabel: visible ? state!.placeLabel : null,
      source: visible ? state!.source : null,
      assignmentId: a?.id ?? null,
      deviceId: device?.id ?? null,
      deviceCode: device?.deviceCode ?? null,
      deviceType: device?.deviceType ?? null,
      gpsStatus: device ? gpsStatusOf(device.lastSeenAt, now) : null,
      deviceLastSeenAt: device?.lastSeenAt?.toISOString() ?? null,
      isSampleData: false,
    };
  }

  /** Current-location rows for the students matching the filters (before tracking/location filters). */
  private async baseRows(user: AuthUser, q: TrackingListQuery) {
    const where = await this.trackingWhere(user, q.campusId);
    const text = q.q?.trim();
    const students = await this.prisma.student.findMany({
      where: {
        AND: [
          where,
          { status: 'active' },
          ...(q.sectionId && isUuid(q.sectionId) ? [{ sectionId: q.sectionId }] : []),
          ...(q.classId && isUuid(q.classId) ? [{ section: { classId: q.classId } }] : []),
          ...(text ? [{ OR: [{ fullName: { contains: text, mode: 'insensitive' as const } }, { admissionNo: { contains: text, mode: 'insensitive' as const } }] }] : []),
        ],
      },
      select: STUDENT_SELECT,
    });
    const ids = students.map((s) => s.id);
    const [states, assignments, staleMinutes] = await Promise.all([this.states(ids), this.activeAssignments(ids), this.config.staleAfterMinutes()]);
    const now = Date.now();
    const rows = students.map((s) => this.buildRow(s, states.get(s.id), assignments.get(s.id), staleMinutes * 60_000, now));
    return { rows, staleMinutes };
  }

  private applyFilters<T extends ReturnType<LocationService['buildRow']>>(rows: T[], q: TrackingListQuery): T[] {
    let out = rows;
    switch (q.status) {
      case 'active': out = out.filter((r) => r.displayStatus === 'Tracking Active'); break;
      case 'offline': out = out.filter((r) => r.displayStatus === 'Offline' || r.displayStatus === 'No Location Yet'); break;
      case 'paused': out = out.filter((r) => r.trackingStatus === 'paused'); break;
      case 'disabled': out = out.filter((r) => r.trackingStatus === 'disabled'); break;
      default: break;
    }
    if (q.locationStatus) out = out.filter((r) => r.locationStatus === q.locationStatus && !r.isStale);
    return out;
  }

  /** GET /tracking/students — paged current locations. */
  async list(user: AuthUser, q: TrackingListQuery, req: Request) {
    const { rows } = await this.baseRows(user, q);
    const filtered = this.applyFilters(rows, q);
    const dir = q.dir === 'desc' ? -1 : 1;
    const byName = (a: (typeof rows)[number], b: (typeof rows)[number]) => a.fullName.localeCompare(b.fullName);
    const cmp: Record<string, (a: (typeof rows)[number], b: (typeof rows)[number]) => number> = {
      name: (a, b) => dir * byName(a, b),
      updated: (a, b) => {
        if (!a.recordedAt && !b.recordedAt) return byName(a, b);
        if (!a.recordedAt) return 1;
        if (!b.recordedAt) return -1;
        return dir * a.recordedAt.localeCompare(b.recordedAt) || byName(a, b);
      },
      status: (a, b) => dir * (DISPLAY_RANK[a.displayStatus] - DISPLAY_RANK[b.displayStatus]) || byName(a, b),
      grade: (a, b) => dir * (a.gradeLevel - b.gradeLevel || (a.section ?? '').localeCompare(b.section ?? '')) || byName(a, b),
    };
    filtered.sort(cmp[q.sort ?? 'name'] ?? cmp.name);
    const p = pageOf(q, 25);
    const page = filtered.slice(p.skip, p.skip + p.take);
    if (page.some((r) => r.latitude != null)) {
      await this.auditView(user, `list|${q.q ?? ''}|${q.classId ?? ''}|${q.sectionId ?? ''}|${q.campusId ?? ''}`, {
        entityType: 'student_location', description: `Viewed current locations of ${page.filter((r) => r.latitude != null).length} students (tracking list)`, req,
        campusId: q.campusId && isUuid(q.campusId) ? q.campusId : null,
      });
    }
    return paged(page.map(({ gradeLevel: _g, ...r }) => r), filtered.length, p);
  }

  /** GET /tracking/map — markers for students with a recorded location, campus zones and the live summary. */
  async map(user: AuthUser, q: TrackingListQuery, req: Request) {
    const { rows, staleMinutes } = await this.baseRows(user, q);
    const live = (r: (typeof rows)[number], s: LocationStatus) => r.locationStatus === s && !r.isStale;
    const summary = {
      total: rows.length,
      active: rows.filter((r) => r.displayStatus === 'Tracking Active').length,
      paused: rows.filter((r) => r.trackingStatus === 'paused').length,
      disabled: rows.filter((r) => r.trackingStatus === 'disabled').length,
      offline: rows.filter((r) => r.displayStatus === 'Offline' || r.displayStatus === 'No Location Yet').length,
      noLocation: rows.filter((r) => r.displayStatus === 'No Location Yet').length,
      atSchool: rows.filter((r) => live(r, 'at_school')).length,
      inTransit: rows.filter((r) => live(r, 'in_transit')).length,
      atHome: rows.filter((r) => live(r, 'at_home')).length,
      onTrip: rows.filter((r) => live(r, 'on_trip')).length,
      withDevice: rows.filter((r) => r.deviceCode).length,
    };
    const markers = this.applyFilters(rows, q)
      .filter((r) => r.latitude != null && r.longitude != null)
      .map((r) => ({
        studentId: r.studentId, fullName: r.fullName, admissionNo: r.admissionNo, grade: r.grade, section: r.section,
        latitude: r.latitude!, longitude: r.longitude!, accuracy: r.accuracy, locationStatus: r.locationStatus, locationStatusLabel: r.locationStatusLabel,
        displayStatus: r.displayStatus, recordedAt: r.recordedAt, isStale: r.isStale, placeLabel: r.placeLabel, batteryPct: r.batteryPct,
        deviceCode: r.deviceCode, gpsStatus: r.gpsStatus,
      }));
    const campusIds = new Set(rows.map((r) => r.campusId));
    const scoped = campusParam(q.campusId);
    const campuses = (await this.config.campuses())
      .filter((c) => hasPoint(c) && (scoped ? c.id === scoped : campusIds.size === 0 || campusIds.has(c.id)))
      .map((c) => ({ id: c.id, name: c.name, latitude: c.latitude!, longitude: c.longitude!, radiusM: c.radiusM }));
    if (markers.length) {
      await this.auditView(user, `map|${q.q ?? ''}|${q.classId ?? ''}|${q.sectionId ?? ''}|${q.campusId ?? ''}|${q.status ?? ''}|${q.locationStatus ?? ''}`, {
        entityType: 'student_location', description: `Viewed the live tracking map (${markers.length} students)`, req,
        campusId: scoped ?? null,
      });
    }
    return { summary, markers, campuses, staleAfterMinutes: staleMinutes, generatedAt: new Date().toISOString() };
  }

  // -------------------------------------------------------------------------
  // One student (staff screens and the family portal)
  // -------------------------------------------------------------------------

  /**
   * Current location of one student (CurrentLocation shape), audited as a sensitive read.
   * The caller checks access first (assertCanView for staff; the family module checks guardianship).
   */
  async current(studentId: string, viewer: AuthUser, req?: Request, opts: { audience?: 'staff' | 'family' } = {}) {
    if (!isUuid(studentId)) throw notFound('Student');
    const s = await this.prisma.student.findUnique({ where: { id: studentId }, select: STUDENT_SELECT });
    if (!s) throw notFound('Student');
    const [states, assignments, staleMinutes] = await Promise.all([this.states([s.id]), this.activeAssignments([s.id]), this.config.staleAfterMinutes()]);
    const row = this.buildRow(s, states.get(s.id), assignments.get(s.id), staleMinutes * 60_000, Date.now());
    const { gradeLevel: _g, ...out } = row;
    await this.auditView(viewer, `student|${s.id}`, {
      entityType: 'student', entityId: s.id, campusId: s.campusId, req,
      description: `Viewed the ${opts.audience === 'family' ? 'location (family portal)' : 'current location'} of ${s.fullName} (${s.admissionNo})`,
    });
    return { ...out, staleAfterMinutes: staleMinutes };
  }

  /**
   * Location history for one day (optionally a time window), with the days that have data.
   * `maxDays` limits how far back the viewer may look (the family portal passes tracking.parent_history_days).
   */
  async history(studentId: string, q: { date?: string; from?: string; to?: string }, viewer: AuthUser, req?: Request, opts: { maxDays?: number; audience?: 'staff' | 'family' } = {}) {
    if (!isUuid(studentId)) throw notFound('Student');
    const student = await this.prisma.student.findUnique({ where: { id: studentId }, select: { id: true, fullName: true, admissionNo: true, campusId: true, trackingStatus: true } });
    if (!student) throw notFound('Student');
    const clock = await this.config.clock();
    const date = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : clock.today;
    if (date > clock.today) throw badRequest('Choose today or an earlier date');
    const earliest = opts.maxDays ? shiftDay(clock.today, -(opts.maxDays - 1)) : null;
    if (earliest && date < earliest) throw badRequest(`Location history is available for the last ${opts.maxDays} days only`);
    const fromMin = timeToMinutes(q.from);
    const toMin = timeToMinutes(q.to);
    if (q.from && fromMin == null) throw badRequest('Use a time like 07:30 for “From”');
    if (q.to && toMin == null) throw badRequest('Use a time like 16:00 for “To”');
    if (fromMin != null && toMin != null && fromMin > toMin) throw badRequest('“From” must be before “To”');
    const start = localInstant(date, fromMin ?? 0, clock.tz);
    const end = localInstant(date, toMin != null ? toMin + 1 : 1440, clock.tz);
    const hidden = opts.audience === 'family' && student.trackingStatus === 'disabled';

    const all = hidden ? [] : await this.prisma.trackingLocation.findMany({
      where: { studentId, recordedAt: { gte: start, lt: end } },
      orderBy: { recordedAt: 'asc' },
      take: 20_000,
    });
    const deviceIds = [...new Set(all.map((p) => p.deviceId).filter((d): d is string => !!d))];
    const devices = deviceIds.length ? await this.prisma.trackingDevice.findMany({ where: { id: { in: deviceIds } }, select: { id: true, deviceCode: true } }) : [];
    const codeOf = new Map(devices.map((d) => [d.id, d.deviceCode]));
    let distance = 0;
    for (let i = 1; i < all.length; i++) distance += distanceM(all[i - 1], all[i]);
    const step = Math.max(1, Math.ceil(all.length / 1500));
    const points = all.filter((_, i) => i % step === 0 || i === all.length - 1).map((p) => ({
      id: Number(p.id),
      latitude: p.latitude,
      longitude: p.longitude,
      accuracy: p.accuracy,
      speed: p.speed,
      heading: p.heading,
      batteryPct: p.batteryPct,
      recordedAt: p.recordedAt.toISOString(),
      locationStatus: p.locationStatus as LocationStatus,
      locationStatusLabel: LOCATION_LABEL[p.locationStatus as LocationStatus] ?? LOCATION_LABEL.unknown,
      placeLabel: p.placeLabel,
      deviceCode: p.deviceId ? codeOf.get(p.deviceId) ?? null : null,
      source: p.source,
    }));

    const lookback = opts.maxDays ?? 60;
    const since = localInstant(shiftDay(clock.today, -(lookback - 1)), 0, clock.tz);
    const days = hidden ? [] : await this.prisma.$queryRaw<{ d: string; n: number }[]>`
      SELECT to_char(("recordedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${clock.tz}, 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
      FROM "TrackingLocation"
      WHERE "studentId" = ${studentId}::uuid AND "recordedAt" >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      GROUP BY 1 ORDER BY 1 DESC LIMIT 120`;

    await this.auditView(viewer, `history|${studentId}|${date}|${q.from ?? ''}|${q.to ?? ''}`, {
      entityType: 'student', entityId: studentId, campusId: student.campusId, req,
      description: `Viewed the location history of ${student.fullName} (${student.admissionNo}) for ${date}${q.from || q.to ? ` ${q.from ?? '00:00'}–${q.to ?? '23:59'}` : ''}${opts.audience === 'family' ? ' (family portal)' : ''}`,
    });
    return {
      studentId,
      date,
      from: q.from ?? null,
      to: q.to ?? null,
      points,
      availableDays: days.map((d) => ({ date: d.d, points: Number(d.n) })),
      historyDays: opts.maxDays ?? null,
      summary: {
        count: all.length,
        distanceKm: round(distance / 1000, 1),
        firstAt: all[0]?.recordedAt.toISOString() ?? null,
        lastAt: all[all.length - 1]?.recordedAt.toISOString() ?? null,
      },
    };
  }

  /** Family portal: current location of a child (caller has checked the guardian link). */
  familyCurrent(studentId: string, viewer: AuthUser, req?: Request) {
    return this.current(studentId, viewer, req, { audience: 'family' });
  }

  /** Family portal: history limited to tracking.parent_history_days (caller has checked the guardian link). */
  async familyHistory(studentId: string, q: { date?: string; from?: string; to?: string }, viewer: AuthUser, req?: Request) {
    return this.history(studentId, q, viewer, req, { maxDays: await this.config.parentHistoryDays(), audience: 'family' });
  }

  // -------------------------------------------------------------------------
  // Tracking settings
  // -------------------------------------------------------------------------

  async updateProfile(studentId: string, dto: {
    trackingEnabled?: boolean; trackingStatus?: 'active' | 'paused' | 'disabled'; homeLatitude?: number | null; homeLongitude?: number | null;
    tripLabel?: string | null; tripUntil?: string | null;
  }, user: AuthUser, req: Request) {
    const s = await this.prisma.student.findUnique({ where: { id: studentId }, select: { id: true, fullName: true, admissionNo: true, campusId: true, trackingStatus: true, trackingConsentAt: true } });
    if (!s) throw notFound('Student');
    let status = s.trackingStatus;
    if (dto.trackingEnabled === false) status = 'disabled';
    else if (dto.trackingEnabled === true && status === 'disabled') status = 'active';
    if (dto.trackingStatus) {
      if (dto.trackingStatus !== 'disabled' && status === 'disabled' && dto.trackingEnabled !== true) throw badRequest('Enable tracking for this student first');
      status = dto.trackingStatus;
    }
    const changes: string[] = [];
    if (status !== s.trackingStatus) {
      await this.prisma.student.update({
        where: { id: s.id },
        data: { trackingStatus: status, ...(status !== 'disabled' && !s.trackingConsentAt ? { trackingConsentAt: new Date() } : {}) },
      });
      changes.push(`tracking ${s.trackingStatus} → ${status}`);
    }
    const stateData: Prisma.TrackingStudentStateUncheckedUpdateInput = {};
    if (dto.homeLatitude !== undefined || dto.homeLongitude !== undefined) {
      const lat = dto.homeLatitude ?? null;
      const lng = dto.homeLongitude ?? null;
      if ((lat == null) !== (lng == null)) throw badRequest('Give both latitude and longitude for the home point');
      Object.assign(stateData, { homeLatitude: lat, homeLongitude: lng });
      changes.push(lat == null ? 'home point cleared' : 'home point set');
    }
    if (dto.tripUntil !== undefined || dto.tripLabel !== undefined) {
      const until = dto.tripUntil ? new Date(dto.tripUntil) : null;
      if (until && Number.isNaN(until.getTime())) throw badRequest('Use a valid date and time for the trip end');
      Object.assign(stateData, { tripUntil: until, tripLabel: until ? dto.tripLabel?.trim() || 'School trip' : null });
      changes.push(until ? `on a school trip until ${until.toISOString()}` : 'school trip ended');
    }
    if (Object.keys(stateData).length) {
      await this.prisma.trackingStudentState.upsert({
        where: { studentId: s.id },
        create: { ...(stateData as Prisma.TrackingStudentStateUncheckedCreateInput), studentId: s.id },
        update: stateData,
      });
    }
    if (changes.length) {
      await this.audit.record({
        user, req, action: 'update', module: 'tracking', entityType: 'student', entityId: s.id, campusId: s.campusId,
        description: `Tracking settings for ${s.fullName} (${s.admissionNo}): ${changes.join(', ')}`,
      });
    }
    return { studentId: s.id, trackingStatus: status, trackingEnabled: status !== 'disabled' };
  }

  // -------------------------------------------------------------------------
  // Recording locations
  // -------------------------------------------------------------------------

  /**
   * Stores location fixes for a student (only while tracking is active, i.e. with consent) and refreshes
   * the current-location snapshot. Returns how many fixes were stored.
   */
  async recordStudentPoints(input: { studentId: string; deviceId?: string | null; assignmentId?: string | null; points: DevicePoint[]; source: string }): Promise<number> {
    const student = await this.prisma.student.findUnique({ where: { id: input.studentId }, select: { id: true, status: true, trackingStatus: true } });
    if (!student || student.status !== 'active' || student.trackingStatus !== 'active' || !input.points.length) return 0;
    const sorted = [...input.points].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
    const [campuses, state, bus] = await Promise.all([
      this.config.campuses(),
      this.prisma.trackingStudentState.findUnique({ where: { studentId: student.id } }),
      this.transport.busState(student.id).catch(() => null),
    ]);
    const rows = sorted.map((p) => {
      const c = this.classify(p, campuses, state, bus);
      return {
        studentId: student.id, deviceId: input.deviceId ?? null, assignmentId: input.assignmentId ?? null,
        latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy, speed: p.speed, heading: p.heading, batteryPct: p.batteryPct,
        locationStatus: c.status, placeLabel: c.place, campusId: c.campusId, routeId: c.routeId, source: input.source, recordedAt: p.recordedAt,
      };
    });
    await this.prisma.trackingLocation.createMany({ data: rows });
    const latest = rows[rows.length - 1];
    if (!state?.recordedAt || latest.recordedAt > state.recordedAt) {
      const snap = {
        latitude: latest.latitude, longitude: latest.longitude, accuracy: latest.accuracy, speed: latest.speed, batteryPct: latest.batteryPct,
        locationStatus: latest.locationStatus, placeLabel: latest.placeLabel, deviceId: latest.deviceId, source: latest.source, recordedAt: latest.recordedAt,
      };
      await this.prisma.trackingStudentState.upsert({ where: { studentId: student.id }, create: { studentId: student.id, ...snap }, update: snap });
    }
    return rows.length;
  }

  /** At school (campus zone) › on a trip › on the bus › at home (home point or bus stop) › moving › unknown. */
  private classify(
    p: DevicePoint,
    campuses: CampusGeo[],
    state: TrackingStudentState | null,
    bus: Awaited<ReturnType<TransportService['busState']>>,
  ): { status: LocationStatus; place: string | null; campusId: string | null; routeId: string | null } {
    for (const c of campuses) {
      if (hasPoint(c) && distanceM(p, c) <= (c.radiusM || 250)) return { status: 'at_school', place: c.name, campusId: c.id, routeId: null };
    }
    if (state?.tripUntil && state.tripUntil > p.recordedAt) return { status: 'on_trip', place: state.tripLabel ?? 'School trip', campusId: null, routeId: null };
    if (bus && (bus.boarded || (bus.runMoving && bus.busPosition && distanceM(p, bus.busPosition) <= ON_BUS_RADIUS_M))) {
      return { status: 'in_transit', place: `On ${bus.label} · ${bus.routeName}`, campusId: null, routeId: bus.routeId };
    }
    const home: (LatLng & { label: string }) | null = state?.homeLatitude != null && state.homeLongitude != null
      ? { latitude: state.homeLatitude, longitude: state.homeLongitude, label: 'Home' }
      : bus?.stop ? { ...bus.stop, label: `Near home stop · ${bus.stop.name}` } : null;
    if (home && distanceM(p, home) <= HOME_RADIUS_M) return { status: 'at_home', place: home.label, campusId: null, routeId: null };
    if (p.speed != null && p.speed >= MOVING_SPEED) return { status: 'in_transit', place: 'On the move', campusId: null, routeId: null };
    return { status: 'unknown', place: null, campusId: null, routeId: null };
  }
}
