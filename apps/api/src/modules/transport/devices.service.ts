import { Injectable } from '@nestjs/common';
import type { Prisma, TrackingAssignment, TrackingDevice } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { CryptoService } from '../../common/crypto.service';
import { paged } from '../../common/envelope';
import { AppError, badRequest, conflict, fieldError, notFound } from '../../common/errors';
import { pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { gradeLabel, isUuid } from './geo';
import { GPS_OFFLINE_SECONDS, GPS_ONLINE_SECONDS, gpsStatusOf, LOW_BATTERY_PCT } from './transport-config.service';

export const DEVICE_TYPES = ['gps_tracker', 'id_card_tag', 'wearable', 'mobile_app'] as const;
export const DEVICE_STATUSES = ['available', 'assigned', 'maintenance', 'inactive', 'lost'] as const;
const OUT_OF_SERVICE = ['maintenance', 'inactive', 'lost'];

export interface DeviceListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  campusId?: string;
  status?: string;
  deviceType?: string;
  gpsStatus?: string;
}

type DeviceWithActive = TrackingDevice & { assignments: TrackingAssignment[] };
interface StudentLite { id: string; fullName: string; admissionNo: string; grade: string | null; section: string | null }

const STATUS_VERB: Record<string, string> = {
  maintenance: 'sent for maintenance',
  lost: 'marked as lost',
  inactive: 'disabled',
  available: 'back in service',
};
const END_REASON: Record<string, string> = {
  maintenance: 'Device sent for maintenance',
  lost: 'Device lost',
  inactive: 'Device disabled',
};

/** GPS devices (register, label, token, status) and their assignments to students. */
@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async studentsById(ids: string[]): Promise<Map<string, StudentLite>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = await this.prisma.student.findMany({
      where: { id: { in: unique } },
      select: { id: true, fullName: true, admissionNo: true, section: { select: { name: true, class: { select: { name: true } } } } },
    });
    return new Map(rows.map((s) => [s.id, { id: s.id, fullName: s.fullName, admissionNo: s.admissionNo, grade: gradeLabel(s.section.class.name), section: s.section.name }]));
  }

  private async campusNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((i): i is string => !!i))];
    if (!unique.length) return new Map<string, string>();
    const rows = await this.prisma.campus.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(rows.map((c) => [c.id, c.name]));
  }

  private async vehiclesByDevice(ids: string[]) {
    if (!ids.length) return new Map<string, { id: string; busNo: string }>();
    const rows = await this.prisma.transportVehicle.findMany({ where: { gpsDeviceId: { in: ids } }, select: { id: true, busNo: true, gpsDeviceId: true } });
    return new Map(rows.map((v) => [v.gpsDeviceId!, { id: v.id, busNo: v.busNo }]));
  }

  private row(d: DeviceWithActive, students: Map<string, StudentLite>, campuses: Map<string, string>, vehicles: Map<string, { id: string; busNo: string }>, now = Date.now()) {
    const a = d.assignments.find((x) => x.status === 'active') ?? null;
    const st = a ? students.get(a.studentId) ?? null : null;
    const vehicle = vehicles.get(d.id) ?? null;
    return {
      id: d.id,
      deviceCode: d.deviceCode,
      deviceType: d.deviceType,
      imei: d.imei,
      serialNumber: d.serialNumber,
      firmwareVersion: d.firmwareVersion,
      campusId: d.campusId,
      campusName: d.campusId ? campuses.get(d.campusId) ?? null : null,
      status: d.status,
      statusReason: d.statusReason,
      gpsStatus: gpsStatusOf(d.lastSeenAt, now),
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      batteryPct: d.batteryPct != null ? Math.round(d.batteryPct) : null,
      hasToken: !!d.tokenHash,
      tokenIssuedAt: d.tokenIssuedAt?.toISOString() ?? null,
      assignmentId: a?.id ?? null,
      studentId: a?.studentId ?? null,
      studentName: st?.fullName ?? null,
      admissionNo: st?.admissionNo ?? null,
      grade: st?.grade ?? null,
      section: st?.section ?? null,
      assignedAt: a?.assignedAt.toISOString() ?? null,
      vehicleId: vehicle?.id ?? null,
      busNo: vehicle?.busNo ?? null,
      notes: d.notes,
      isSampleData: false,
      createdAt: d.createdAt.toISOString(),
    };
  }

  private async rows(devices: DeviceWithActive[]) {
    const [students, campuses, vehicles] = await Promise.all([
      this.studentsById(devices.flatMap((d) => d.assignments.filter((a) => a.status === 'active').map((a) => a.studentId))),
      this.campusNames(devices.map((d) => d.campusId)),
      this.vehiclesByDevice(devices.map((d) => d.id)),
    ]);
    const now = Date.now();
    return devices.map((d) => this.row(d, students, campuses, vehicles, now));
  }

  private async find(id: string): Promise<DeviceWithActive> {
    const d = isUuid(id) ? await this.prisma.trackingDevice.findUnique({ where: { id }, include: { assignments: { where: { status: 'active' } } } }) : null;
    if (!d) throw notFound('Device');
    return d;
  }

  private gpsWhere(gps: string | undefined): Prisma.TrackingDeviceWhereInput {
    const now = Date.now();
    const online = new Date(now - GPS_ONLINE_SECONDS * 1000);
    const offline = new Date(now - GPS_OFFLINE_SECONDS * 1000);
    switch (gps) {
      case 'online': return { lastSeenAt: { gte: online } };
      case 'stale': return { lastSeenAt: { lt: online, gte: offline } };
      case 'offline': return { lastSeenAt: { lt: offline } };
      case 'never': return { lastSeenAt: null };
      default: return {};
    }
  }

  private campusWhere(campusId: string | undefined): Prisma.TrackingDeviceWhereInput {
    return campusId ? { OR: [{ campusId }, { campusId: null }] } : {};
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  /** GET /devices — paged, filtered and sorted. */
  async list(q: DeviceListQuery, campusId: string | undefined) {
    const where: Prisma.TrackingDeviceWhereInput = {
      AND: [
        this.campusWhere(campusId),
        q.status ? { status: q.status } : {},
        q.deviceType ? { deviceType: q.deviceType } : {},
        this.gpsWhere(q.gpsStatus),
      ],
    };
    const text = q.q?.trim();
    if (text) {
      const students = await this.prisma.student.findMany({
        where: { OR: [{ fullName: { contains: text, mode: 'insensitive' } }, { admissionNo: { contains: text, mode: 'insensitive' } }] },
        select: { id: true },
        take: 500,
      });
      (where.AND as Prisma.TrackingDeviceWhereInput[]).push({
        OR: [
          { deviceCode: { contains: text, mode: 'insensitive' } },
          { imei: { contains: text } },
          { serialNumber: { contains: text, mode: 'insensitive' } },
          ...(students.length ? [{ assignments: { some: { status: 'active', studentId: { in: students.map((s) => s.id) } } } }] : []),
        ],
      });
    }
    const p = pageOf(q, 25);
    const dir = q.dir === 'desc' ? 'desc' : 'asc';
    const dbSort: Record<string, Prisma.TrackingDeviceOrderByWithRelationInput[]> = {
      code: [{ deviceCode: dir }],
      type: [{ deviceType: dir }, { deviceCode: 'asc' }],
      status: [{ status: dir }, { deviceCode: 'asc' }],
      seen: [{ lastSeenAt: { sort: dir, nulls: 'last' } }, { deviceCode: 'asc' }],
      battery: [{ batteryPct: { sort: dir, nulls: 'last' } }, { deviceCode: 'asc' }],
    };
    if (q.sort === 'student') {
      // Sorted by the assigned student's name (unassigned devices last).
      const all = await this.prisma.trackingDevice.findMany({ where, include: { assignments: { where: { status: 'active' } } } });
      const rows = await this.rows(all);
      rows.sort((a, b) => {
        if (!a.studentName && !b.studentName) return a.deviceCode.localeCompare(b.deviceCode);
        if (!a.studentName) return 1;
        if (!b.studentName) return -1;
        return (dir === 'desc' ? -1 : 1) * a.studentName.localeCompare(b.studentName);
      });
      return paged(rows.slice(p.skip, p.skip + p.take), rows.length, p);
    }
    const [devices, total] = await Promise.all([
      this.prisma.trackingDevice.findMany({
        where, include: { assignments: { where: { status: 'active' } } }, orderBy: dbSort[q.sort ?? 'code'] ?? dbSort.code, skip: p.skip, take: p.take,
      }),
      this.prisma.trackingDevice.count({ where }),
    ]);
    return paged(await this.rows(devices), total, p);
  }

  /** GET /devices/summary */
  async summary(campusId: string | undefined) {
    const devices = await this.prisma.trackingDevice.findMany({
      where: this.campusWhere(campusId),
      select: { status: true, lastSeenAt: true, batteryPct: true },
    });
    const now = Date.now();
    const count = (s: string) => devices.filter((d) => d.status === s).length;
    const assigned = devices.filter((d) => d.status === 'assigned');
    const gps = (s: string) => assigned.filter((d) => gpsStatusOf(d.lastSeenAt, now) === s).length;
    const inService = devices.filter((d) => !OUT_OF_SERVICE.includes(d.status));
    return {
      total: devices.length,
      assigned: assigned.length,
      available: count('available'),
      maintenance: count('maintenance'),
      inactive: count('inactive'),
      lost: count('lost'),
      outOfService: count('maintenance') + count('lost'),
      online: gps('online'),
      stale: gps('stale'),
      offline: gps('offline'),
      never: gps('never'),
      lowBattery: inService.filter((d) => d.batteryPct != null && d.batteryPct < LOW_BATTERY_PCT).length,
      thresholds: { onlineSeconds: GPS_ONLINE_SECONDS, offlineSeconds: GPS_OFFLINE_SECONDS, lowBatteryPct: LOW_BATTERY_PCT },
    };
  }

  /** GET /devices/lookup?code= — a scanned QR label (device code), a typed device ID or an IMEI. */
  async lookup(raw: string | undefined) {
    let text = (raw ?? '').trim();
    if (!text) throw badRequest('Scan the QR label or type the device ID');
    // The phone-setup QR carries the device ID as a parameter.
    const m = /[?&]device=([^&]+)/.exec(text);
    if (m) text = decodeURIComponent(m[1]);
    const code = text.toUpperCase();
    const d = await this.prisma.trackingDevice.findFirst({
      where: { OR: [{ deviceCode: code }, { imei: text }, { serialNumber: { equals: text, mode: 'insensitive' } }] },
      include: { assignments: { where: { status: 'active' } } },
    });
    if (!d) throw new AppError(404, 'NOT_FOUND', `No registered device has the ID or IMEI “${text.slice(0, 60)}”`);
    return (await this.rows([d]))[0];
  }

  /** GET /devices/:id — device with its full assignment history and the locations recorded under each. */
  async detail(id: string) {
    const d = await this.find(id);
    const [row] = await this.rows([d]);
    const history = await this.prisma.trackingAssignment.findMany({ where: { deviceId: d.id }, orderBy: { assignedAt: 'desc' } });
    const students = await this.studentsById(history.map((h) => h.studentId));
    const counts = history.length
      ? await this.prisma.trackingLocation.groupBy({ by: ['assignmentId'], where: { assignmentId: { in: history.map((h) => h.id) } }, _count: { _all: true } })
      : [];
    const countOf = new Map(counts.map((c) => [c.assignmentId, c._count._all]));
    return {
      ...row,
      assignments: history.map((h) => ({
        id: h.id,
        studentId: h.studentId,
        studentName: students.get(h.studentId)?.fullName ?? 'Former student',
        admissionNo: students.get(h.studentId)?.admissionNo ?? '',
        status: h.status,
        assignedAt: h.assignedAt.toISOString(),
        assignedBy: h.assignedByName,
        notes: h.notes,
        unassignedAt: h.unassignedAt?.toISOString() ?? null,
        unassignedBy: h.unassignedByName,
        unassignReason: h.unassignReason,
        locationCount: countOf.get(h.id) ?? 0,
      })),
    };
  }

  private async nextCode(): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const code = `GPS${String(await this.counters.next('gps-device')).padStart(6, '0')}`;
      if (!(await this.prisma.trackingDevice.findUnique({ where: { deviceCode: code }, select: { id: true } }))) return code;
    }
    throw conflict('Could not generate a device ID — type one instead');
  }

  private newToken() {
    const token = this.crypto.randomToken(32);
    return { token, hash: this.crypto.sha256(token) };
  }

  /** POST /devices — registers a device and returns its token once. */
  async register(dto: {
    deviceType: string; deviceCode?: string; imei?: string; serialNumber?: string; firmwareVersion?: string; campusId?: string; notes?: string;
  }, user: AuthUser, req: Request) {
    const deviceCode = dto.deviceCode?.trim() ? dto.deviceCode.trim().toUpperCase() : await this.nextCode();
    if (await this.prisma.trackingDevice.findUnique({ where: { deviceCode }, select: { id: true } })) throw fieldError('deviceCode', `Device ID ${deviceCode} is already registered`);
    const imei = dto.imei?.trim() || null;
    if (imei) {
      const other = await this.prisma.trackingDevice.findUnique({ where: { imei }, select: { deviceCode: true } });
      if (other) throw fieldError('imei', `IMEI ${imei} is already registered to ${other.deviceCode}`);
    }
    if (dto.campusId && !(await this.prisma.campus.findUnique({ where: { id: dto.campusId }, select: { id: true } }))) throw fieldError('campusId', 'Choose a campus');
    const { token, hash } = this.newToken();
    const device = await this.prisma.trackingDevice.create({
      data: {
        deviceCode, deviceType: dto.deviceType, imei, serialNumber: dto.serialNumber?.trim() || null, firmwareVersion: dto.firmwareVersion?.trim() || null,
        campusId: dto.campusId || null, notes: dto.notes?.trim() || null, tokenHash: hash, tokenIssuedAt: new Date(),
      },
      include: { assignments: true },
    });
    await this.audit.record({
      user, req, action: 'create', module: 'tracking', entityType: 'device', entityId: device.id, campusId: device.campusId,
      description: `Registered GPS device ${deviceCode} (${dto.deviceType}${imei ? `, IMEI ${imei}` : ''}) and issued its token`,
    });
    return { device: (await this.rows([device]))[0], token };
  }

  /** POST /devices/:id/token — replaces the token; the old one stops working immediately. */
  async issueToken(id: string, user: AuthUser, req: Request) {
    const d = await this.find(id);
    const { token, hash } = this.newToken();
    await this.prisma.trackingDevice.update({ where: { id: d.id }, data: { tokenHash: hash, tokenIssuedAt: new Date() } });
    await this.audit.record({
      user, req, action: 'update', module: 'tracking', entityType: 'device', entityId: d.id, campusId: d.campusId,
      description: `${d.tokenHash ? 'Replaced' : 'Issued'} the device token for ${d.deviceCode}`,
    });
    return { deviceCode: d.deviceCode, token };
  }

  /** PUT /devices/:id — details and status (taking a device out of service ends its assignment; history is kept). */
  async update(id: string, dto: {
    status?: string; reason?: string; deviceType?: string; imei?: string | null; serialNumber?: string | null; firmwareVersion?: string | null;
    campusId?: string | null; notes?: string | null;
  }, user: AuthUser, req: Request) {
    const d = await this.find(id);
    const data: Prisma.TrackingDeviceUpdateInput = {};
    const notes: string[] = [];
    if (dto.deviceType && dto.deviceType !== d.deviceType) { data.deviceType = dto.deviceType; notes.push(`type ${dto.deviceType}`); }
    if (dto.imei !== undefined && (dto.imei?.trim() || null) !== d.imei) {
      const imei = dto.imei?.trim() || null;
      if (imei) {
        const other = await this.prisma.trackingDevice.findFirst({ where: { imei, id: { not: d.id } }, select: { deviceCode: true } });
        if (other) throw fieldError('imei', `IMEI ${imei} is already registered to ${other.deviceCode}`);
      }
      data.imei = imei;
      notes.push('IMEI');
    }
    if (dto.serialNumber !== undefined) data.serialNumber = dto.serialNumber?.trim() || null;
    if (dto.firmwareVersion !== undefined) data.firmwareVersion = dto.firmwareVersion?.trim() || null;
    if (dto.notes !== undefined) data.notes = dto.notes?.trim() || null;
    if (dto.campusId !== undefined) {
      if (dto.campusId && !(await this.prisma.campus.findUnique({ where: { id: dto.campusId }, select: { id: true } }))) throw fieldError('campusId', 'Choose a campus');
      data.campusId = dto.campusId || null;
    }

    let message = `${d.deviceCode} updated`;
    if (dto.status && dto.status !== d.status) {
      const to = dto.status;
      if (to === 'assigned') throw badRequest('Assign the device to a student from Device Assignments');
      const vehicle = await this.prisma.transportVehicle.findUnique({ where: { gpsDeviceId: d.id }, select: { busNo: true, id: true } });
      if (to === 'available' && d.assignments.length) throw badRequest(`${d.deviceCode} is assigned to a student — unassign it first`);
      if (to === 'available' && vehicle) throw badRequest(`${d.deviceCode} is mounted on ${vehicle.busNo} — remove it from the vehicle first`);
      const ended = await this.endActive(d, `${END_REASON[to] ?? `Device ${to}`}${dto.reason ? `: ${dto.reason}` : ''}`, user);
      if (vehicle && OUT_OF_SERVICE.includes(to)) await this.prisma.transportVehicle.update({ where: { id: vehicle.id }, data: { gpsDeviceId: null } });
      data.status = to;
      data.statusReason = dto.reason?.trim() || null;
      notes.push(`status ${d.status} → ${to}${dto.reason ? ` (${dto.reason})` : ''}${ended ? ', assignment ended' : ''}${vehicle && OUT_OF_SERVICE.includes(to) ? `, removed from ${vehicle.busNo}` : ''}`);
      message = `${d.deviceCode} ${STATUS_VERB[to] ?? `set to ${to}`}${ended ? ' · assignment ended' : ''}`;
    }
    if (!Object.keys(data).length) return { device: (await this.rows([d]))[0], message: 'No changes to save' };
    await this.prisma.trackingDevice.update({ where: { id: d.id }, data });
    await this.audit.record({
      user, req, action: 'update', module: 'tracking', entityType: 'device', entityId: d.id, campusId: d.campusId,
      description: `Updated GPS device ${d.deviceCode}: ${notes.join(', ') || 'details'}`,
    });
    const fresh = await this.find(d.id);
    return { device: (await this.rows([fresh]))[0], message };
  }

  private async endActive(d: DeviceWithActive, reason: string, user: Pick<AuthUser, 'id' | 'fullName'> | null) {
    if (!d.assignments.length) return 0;
    const r = await this.prisma.trackingAssignment.updateMany({
      where: { deviceId: d.id, status: 'active' },
      data: { status: 'inactive', unassignedAt: new Date(), unassignedById: user?.id ?? null, unassignedByName: user?.fullName ?? 'System', unassignReason: reason.slice(0, 300) },
    });
    return r.count;
  }

  // -------------------------------------------------------------------------
  // Assignments
  // -------------------------------------------------------------------------

  /** GET /device-assignments */
  async assignments(q: { q?: string; status?: string; page?: number; pageSize?: number; sort?: string; dir?: 'asc' | 'desc' }, campusId: string | undefined) {
    const and: Prisma.TrackingAssignmentWhereInput[] = [];
    if (q.status === 'active' || q.status === 'inactive') and.push({ status: q.status });
    if (campusId) {
      const ids = await this.prisma.student.findMany({ where: { campusId }, select: { id: true } });
      and.push({ studentId: { in: ids.map((s) => s.id) } });
    }
    const text = q.q?.trim();
    if (text) {
      const students = await this.prisma.student.findMany({
        where: { OR: [{ fullName: { contains: text, mode: 'insensitive' } }, { admissionNo: { contains: text, mode: 'insensitive' } }] },
        select: { id: true }, take: 500,
      });
      and.push({
        OR: [
          { device: { deviceCode: { contains: text, mode: 'insensitive' } } },
          { device: { imei: { contains: text } } },
          ...(students.length ? [{ studentId: { in: students.map((s) => s.id) } }] : []),
        ],
      });
    }
    const where: Prisma.TrackingAssignmentWhereInput = { AND: and };
    const p = pageOf(q, 25);
    const dir = q.dir === 'asc' ? 'asc' : 'desc';
    const order: Record<string, Prisma.TrackingAssignmentOrderByWithRelationInput[]> = {
      assigned: [{ assignedAt: dir }],
      unassigned: [{ unassignedAt: { sort: dir, nulls: 'last' } }, { assignedAt: 'desc' }],
      device: [{ device: { deviceCode: dir } }, { assignedAt: 'desc' }],
    };
    let rows: Prisma.TrackingAssignmentGetPayload<{ include: { device: true } }>[];
    let total: number;
    if (q.sort === 'student') {
      const all = await this.prisma.trackingAssignment.findMany({ where, include: { device: true } });
      const names = await this.studentsById(all.map((a) => a.studentId));
      all.sort((a, b) => (dir === 'desc' ? -1 : 1) * (names.get(a.studentId)?.fullName ?? '').localeCompare(names.get(b.studentId)?.fullName ?? '') || b.assignedAt.getTime() - a.assignedAt.getTime());
      total = all.length;
      rows = all.slice(p.skip, p.skip + p.take);
    } else {
      [rows, total] = await Promise.all([
        this.prisma.trackingAssignment.findMany({ where, include: { device: true }, orderBy: order[q.sort ?? 'assigned'] ?? order.assigned, skip: p.skip, take: p.take }),
        this.prisma.trackingAssignment.count({ where }),
      ]);
    }
    const students = await this.studentsById(rows.map((r) => r.studentId));
    const now = Date.now();
    return paged(rows.map((a) => {
      const st = students.get(a.studentId);
      return {
        id: a.id,
        studentId: a.studentId,
        studentName: st?.fullName ?? 'Former student',
        admissionNo: st?.admissionNo ?? '',
        grade: st?.grade ?? null,
        section: st?.section ?? null,
        deviceId: a.deviceId,
        deviceCode: a.device.deviceCode,
        deviceType: a.device.deviceType,
        status: a.status as 'active' | 'inactive',
        assignedAt: a.assignedAt.toISOString(),
        assignedBy: a.assignedByName,
        notes: a.notes,
        unassignedAt: a.unassignedAt?.toISOString() ?? null,
        unassignedBy: a.unassignedByName,
        unassignReason: a.unassignReason,
        gpsStatus: gpsStatusOf(a.device.lastSeenAt, now),
        lastSeenAt: a.device.lastSeenAt?.toISOString() ?? null,
        batteryPct: a.device.batteryPct != null ? Math.round(a.device.batteryPct) : null,
      };
    }), total, p);
  }

  /**
   * POST /device-assignments — links a device to a student. When the device is with someone else or the
   * student already carries a device, answers 409 REASSIGN_REQUIRED unless `reassign` is true.
   */
  async assign(dto: { studentId: string; deviceId: string; notes?: string; reassign?: boolean }, user: AuthUser, req: Request) {
    const device = isUuid(dto.deviceId) ? await this.find(dto.deviceId) : null;
    if (!device) throw fieldError('deviceId', 'Choose a registered device');
    const student = await this.prisma.student.findUnique({
      where: { id: dto.studentId },
      select: { id: true, fullName: true, admissionNo: true, campusId: true, status: true, trackingStatus: true, trackingConsentAt: true },
    });
    if (!student || student.status !== 'active') throw fieldError('studentId', 'Choose a current student');
    if (!['available', 'assigned'].includes(device.status)) throw badRequest(`${device.deviceCode} is ${device.status}. Mark it available on the GPS Devices page first.`);
    const vehicle = await this.prisma.transportVehicle.findUnique({ where: { gpsDeviceId: device.id }, select: { busNo: true } });
    if (vehicle) throw badRequest(`${device.deviceCode} is mounted on ${vehicle.busNo} and cannot be given to a student`);

    const current = device.assignments[0] ?? null;
    if (current?.studentId === student.id) throw conflict(`${device.deviceCode} is already assigned to ${student.fullName}`);
    const studentOther = await this.prisma.trackingAssignment.findFirst({ where: { studentId: student.id, status: 'active' }, include: { device: true } });
    if ((current || studentOther) && !dto.reassign) {
      const holder = current ? (await this.studentsById([current.studentId])).get(current.studentId) : null;
      const parts = [
        ...(current ? [`${device.deviceCode} is assigned to ${holder?.fullName ?? 'another student'}${holder ? ` (${holder.admissionNo})` : ''}`] : []),
        ...(studentOther ? [`${student.fullName} already has ${studentOther.device.deviceCode}`] : []),
      ];
      throw new AppError(409, 'REASSIGN_REQUIRED', `${parts.join(' and ')} Confirm to reassign.`, {
        deviceCode: device.deviceCode,
        currentStudentId: current?.studentId ?? null,
        currentStudentName: holder?.fullName ?? null,
        studentDeviceCode: studentOther?.device.deviceCode ?? null,
      });
    }

    const now = new Date();
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    if (current) {
      ops.push(this.prisma.trackingAssignment.update({
        where: { id: current.id },
        data: { status: 'inactive', unassignedAt: now, unassignedById: user.id, unassignedByName: user.fullName, unassignReason: `Reassigned to ${student.fullName} (${student.admissionNo})` },
      }));
    }
    if (studentOther) {
      ops.push(this.prisma.trackingAssignment.update({
        where: { id: studentOther.id },
        data: { status: 'inactive', unassignedAt: now, unassignedById: user.id, unassignedByName: user.fullName, unassignReason: `Replaced by ${device.deviceCode}` },
      }));
      ops.push(this.prisma.trackingDevice.update({ where: { id: studentOther.deviceId }, data: { status: 'available' } }));
    }
    ops.push(this.prisma.trackingDevice.update({ where: { id: device.id }, data: { status: 'assigned', statusReason: null } }));
    const createAt = ops.length;
    ops.push(this.prisma.trackingAssignment.create({
      data: { deviceId: device.id, studentId: student.id, notes: dto.notes?.trim() || null, assignedAt: now, assignedById: user.id, assignedByName: user.fullName },
    }));
    // The guardian's consent is recorded when the tag is issued.
    if (student.trackingStatus !== 'disabled' && !student.trackingConsentAt) {
      ops.push(this.prisma.student.update({ where: { id: student.id }, data: { trackingConsentAt: now } }));
    }
    const results = await this.prisma.$transaction(ops);
    const created = results[createAt] as TrackingAssignment;
    await this.audit.record({
      user, req, action: 'create', module: 'tracking', entityType: 'device_assignment', entityId: created.id, campusId: student.campusId,
      description: `Assigned ${device.deviceCode} to ${student.fullName} (${student.admissionNo})${current ? ' (reassigned)' : ''}${studentOther ? `, replacing ${studentOther.device.deviceCode}` : ''}`,
    });
    const note = student.trackingStatus === 'disabled' ? ' · tracking is disabled for this student — enable it to record locations' : '';
    return {
      data: { id: created.id, deviceId: device.id, deviceCode: device.deviceCode, studentId: student.id, studentName: student.fullName, admissionNo: student.admissionNo },
      message: `${device.deviceCode} assigned to ${student.fullName}${note}`,
    };
  }

  /** POST /device-assignments/:id/unassign — ends the assignment (kept with its locations); the device becomes available. */
  async unassign(id: string, reason: string | undefined, user: AuthUser, req: Request) {
    const a = isUuid(id) ? await this.prisma.trackingAssignment.findUnique({ where: { id }, include: { device: true } }) : null;
    if (!a) throw notFound('Assignment');
    if (a.status !== 'active') throw badRequest('This assignment has already ended');
    const student = (await this.studentsById([a.studentId])).get(a.studentId);
    await this.prisma.$transaction([
      this.prisma.trackingAssignment.update({
        where: { id: a.id },
        data: { status: 'inactive', unassignedAt: new Date(), unassignedById: user.id, unassignedByName: user.fullName, unassignReason: reason?.trim() || null },
      }),
      ...(a.device.status === 'assigned' ? [this.prisma.trackingDevice.update({ where: { id: a.deviceId }, data: { status: 'available' } })] : []),
    ]);
    await this.audit.record({
      user, req, action: 'update', module: 'tracking', entityType: 'device_assignment', entityId: a.id,
      description: `Unassigned ${a.device.deviceCode} from ${student?.fullName ?? 'a student'}${student ? ` (${student.admissionNo})` : ''}${reason ? ` — ${reason}` : ''}`,
    });
    return `${a.device.deviceCode} unassigned from ${student?.admissionNo ?? 'the student'}`;
  }
}
