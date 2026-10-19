import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { TrackingDevice } from '@prisma/client';
import type { Request } from 'express';
import { type AuthUser, can } from '../../common/auth-user';
import { CryptoService } from '../../common/crypto.service';
import { AppError, badRequest, forbidden, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { isUuid } from './geo';
import { type DevicePoint, LocationService } from './location.service';
import { type BusPoint, TransportService } from './transport.service';

/** Oldest buffered fix a device may upload. */
const MAX_AGE_MS = 7 * 24 * 3600_000;
const MAX_POINTS = 500;
const OUT_OF_SERVICE = ['maintenance', 'inactive', 'lost'];
const KNOTS_TO_MS = 0.514444;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function parseTime(v: unknown, now: number): Date {
  let t: number | null = null;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v))) {
    const n = Number(v);
    t = n < 1e12 ? n * 1000 : n; // seconds or milliseconds since the epoch
  } else if (typeof v === 'string' && v) {
    const p = Date.parse(v);
    t = Number.isNaN(p) ? null : p;
  } else if (v instanceof Date) {
    t = v.getTime();
  }
  if (t == null || t > now + 2 * 60_000) return new Date(now);
  return new Date(t);
}

/**
 * Reads one location fix. Accepts the common field names used by trackers and phone apps:
 * latitude|lat, longitude|lng|lon, accuracy, speed (m/s) | speedKmph, heading|bearing|course,
 * battery|batteryPct (0–100) | batteryLevel (0–1), recordedAt|timestamp|time|fixTime (ISO or epoch).
 */
export function parsePoint(raw: unknown, now = Date.now()): DevicePoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const c = (o.coords && typeof o.coords === 'object' ? o.coords : {}) as Record<string, unknown>;
  const latitude = num(o.latitude ?? o.lat ?? c.latitude);
  const longitude = num(o.longitude ?? o.lng ?? o.lon ?? c.longitude);
  if (latitude == null || longitude == null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) return null;
  const kmph = num(o.speedKmph ?? o.speed_kmph);
  const speed = num(o.speed ?? c.speed) ?? (kmph != null ? kmph / 3.6 : null);
  let batteryPct = num(o.batteryPct ?? o.battery ?? o.batt);
  const level = num(o.batteryLevel ?? (o.battery && typeof o.battery === 'object' ? (o.battery as Record<string, unknown>).level : undefined));
  if (batteryPct == null && level != null) batteryPct = level <= 1 ? level * 100 : level;
  const recordedAt = parseTime(o.recordedAt ?? o.timestamp ?? o.time ?? o.fixTime ?? o.deviceTime ?? c.timestamp, now);
  if (now - recordedAt.getTime() > MAX_AGE_MS) return null;
  return {
    latitude,
    longitude,
    accuracy: num(o.accuracy ?? c.accuracy),
    speed: speed != null && speed >= 0 ? speed : null,
    heading: num(o.heading ?? o.bearing ?? o.course ?? c.heading),
    batteryPct: batteryPct != null ? Math.max(0, Math.min(100, batteryPct)) : null,
    recordedAt,
  };
}

/** One request body: a single fix, an array of fixes, or { points | locations: [...] }. */
export function parseBody(body: unknown): { points: DevicePoint[]; battery: number | null } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const list: unknown[] = Array.isArray(body) ? body
    : Array.isArray(b.points) ? b.points
      : Array.isArray(b.locations) ? b.locations
        : b.location && typeof b.location === 'object' ? [b.location]
          : [b];
  const now = Date.now();
  const points = list.slice(0, MAX_POINTS).map((p) => parsePoint(p, now)).filter((p): p is DevicePoint => !!p);
  const battery = num(b.batteryPct ?? b.battery) ?? (num(b.batteryLevel) != null ? Math.min(100, num(b.batteryLevel)! <= 1 ? num(b.batteryLevel)! * 100 : num(b.batteryLevel)!) : null);
  return { points, battery };
}

const toBusPoint = (p: DevicePoint): BusPoint => ({
  latitude: p.latitude, longitude: p.longitude, speedKmph: p.speed != null ? p.speed * 3.6 : null, heading: p.heading, accuracy: p.accuracy, recordedAt: p.recordedAt,
});

/**
 * Location ingest from GPS devices (device token), signed-in integrations (tracking.ingest) and the Traccar
 * integration. Resolves the student from the device's active assignment, or the bus from the vehicle the
 * device is mounted on.
 */
@Injectable()
export class IngestService {
  private readonly log = new Logger(IngestService.name);
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly integrations: IntegrationsService,
    private readonly locations: LocationService,
    private readonly transport: TransportService,
  ) {}

  private deviceToken(req: Request): string | null {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && /^(Bearer|Device)\s+/i.test(auth)) return auth.replace(/^(Bearer|Device)\s+/i, '').trim() || null;
    const h = req.headers['x-device-token'];
    return typeof h === 'string' && h.trim() ? h.trim() : null;
  }

  private deviceHint(req: Request, body: unknown): string | null {
    const h = req.headers['x-device-id'];
    if (typeof h === 'string' && h.trim()) return h.trim();
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const v = b.deviceId ?? b.deviceCode ?? b.device;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  /** Finds the device for a token; failures are written to the audit trail as device_auth_failed. */
  async authenticate(req: Request, body: unknown): Promise<TrackingDevice> {
    const token = this.deviceToken(req);
    const hint = this.deviceHint(req, body);
    const device = token ? await this.prisma.trackingDevice.findUnique({ where: { tokenHash: this.crypto.sha256(token) } }) : null;
    const mismatch = device && hint && hint.toUpperCase() !== device.deviceCode && hint !== device.imei;
    if (!device || mismatch) {
      const claimed = hint ? await this.prisma.trackingDevice.findFirst({ where: { OR: [{ deviceCode: hint.toUpperCase() }, { imei: hint }] }, select: { id: true, deviceCode: true, campusId: true } }) : null;
      await this.audit.record({
        userName: hint ? `Device ${hint.slice(0, 40)}` : 'Unknown device',
        action: 'device_auth_failed',
        module: 'tracking',
        entityType: 'device',
        entityId: claimed?.id,
        campusId: claimed?.campusId ?? null,
        description: !token ? 'GPS device sent a location without a token'
          : mismatch ? `Device token does not belong to ${hint}` : `GPS device sign-in failed: unknown or revoked token${hint ? ` (claimed ${hint})` : ''}`,
        req,
      });
      throw new AppError(401, 'DEVICE_UNAUTHORIZED', token ? 'This device token is not valid. Issue a new token on the GPS Devices page.' : 'Send the device token as Authorization: Bearer <token>');
    }
    return device;
  }

  /** POST /v1/location (and /tracking/ingest) — from a device token, or from a signed-in integration with tracking.ingest. */
  async ingest(req: Request, body: unknown, user: AuthUser | undefined) {
    const parsed = parseBody(body);
    if (user) {
      if (!can(user, 'tracking.ingest')) throw forbidden('Recording locations needs the tracking.ingest permission');
      const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
      if (typeof b.studentId === 'string') {
        if (!isUuid(b.studentId)) throw notFound('Student');
        if (!parsed.points.length) throw badRequest('Send latitude and longitude');
        const stored = await this.locations.recordStudentPoints({ studentId: b.studentId, points: parsed.points, source: 'app' });
        return { accepted: parsed.points.length, stored, studentTracked: stored > 0, serverTime: new Date().toISOString() };
      }
      const code = this.deviceHint(req, body);
      const device = code ? await this.prisma.trackingDevice.findFirst({ where: { OR: [{ deviceCode: code.toUpperCase() }, { imei: code }] } }) : null;
      if (!device) throw badRequest('Send deviceCode (or studentId) with the location');
      return this.fromDevice(device, parsed, 'app', new Date());
    }
    const device = await this.authenticate(req, body);
    return this.fromDevice(device, parsed, 'device', new Date());
  }

  /** GET /v1/location — lets a tracker or the phone app check its token and settings. */
  async whoAmI(req: Request) {
    const device = await this.authenticate(req, undefined);
    const active = await this.prisma.trackingAssignment.count({ where: { deviceId: device.id, status: 'active' } });
    const bus = await this.transport.routesForDevice(device.id);
    await this.prisma.trackingDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
    return {
      deviceCode: device.deviceCode,
      deviceType: device.deviceType,
      status: device.status,
      assigned: active > 0 || !!bus,
      reportsFor: bus ? 'bus' : active > 0 ? 'student' : null,
      intervalSeconds: bus ? 15 : 30,
      serverTime: new Date().toISOString(),
    };
  }

  private async fromDevice(device: TrackingDevice, parsed: { points: DevicePoint[]; battery: number | null }, source: string, contactAt: Date) {
    if (!parsed.points.length && parsed.battery == null) throw badRequest('Send latitude and longitude (or a battery heartbeat)');
    const r = await this.recordDevicePoints(device, parsed.points, source, contactAt, parsed.battery);
    return { deviceCode: device.deviceCode, accepted: parsed.points.length, ...r, serverTime: new Date().toISOString() };
  }

  /** Stores fixes from one device: device health, the bus it is mounted on, and the student it is assigned to. */
  async recordDevicePoints(device: TrackingDevice, points: DevicePoint[], source: string, contactAt: Date, battery: number | null = null) {
    const sorted = [...points].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
    const latest = sorted[sorted.length - 1];
    const lastBattery = [...sorted].reverse().find((p) => p.batteryPct != null)?.batteryPct ?? battery ?? device.batteryPct;
    await this.prisma.trackingDevice.update({
      where: { id: device.id },
      data: {
        lastSeenAt: !device.lastSeenAt || contactAt > device.lastSeenAt ? contactAt : device.lastSeenAt,
        batteryPct: lastBattery,
        ...(latest ? { lastLatitude: latest.latitude, lastLongitude: latest.longitude } : {}),
      },
    });
    if (!sorted.length || OUT_OF_SERVICE.includes(device.status)) return { stored: 0, busStored: 0, studentTracked: false };

    let busStored = 0;
    const bus = await this.transport.routesForDevice(device.id);
    if (bus?.routeIds.length) busStored = await this.transport.recordBusPings(bus.routeIds, sorted.map(toBusPoint), { source, vehicleId: bus.vehicleId, deviceId: device.id });

    let stored = 0;
    const a = await this.prisma.trackingAssignment.findFirst({ where: { deviceId: device.id, status: 'active' }, orderBy: { assignedAt: 'desc' } });
    if (a) {
      const own = sorted.filter((p) => p.recordedAt >= a.assignedAt);
      stored = await this.locations.recordStudentPoints({ studentId: a.studentId, deviceId: device.id, assignmentId: a.id, points: own, source });
    }
    return { stored, busStored, studentTracked: stored > 0 };
  }

  // -------------------------------------------------------------------------
  // Traccar (gps integration with provider "Traccar")
  // -------------------------------------------------------------------------

  /**
   * Polls the Traccar server every minute for the latest positions and records new fixes. Devices are matched
   * by Traccar device id, else by unique id = our IMEI or device ID.
   */
  @Interval(60_000)
  async pollTraccar() {
    if (this.polling) return;
    this.polling = true;
    try {
      const gps = await this.integrations.get('gps').catch(() => null);
      if (!gps?.isEnabled || gps.provider !== 'Traccar') return;
      const base = gps.config.serverUrl?.trim().replace(/\/+$/, '');
      const token = gps.secrets.apiToken;
      if (!base || !token) return;
      const get = async <T>(path: string): Promise<T> => {
        const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`Traccar ${path} returned ${res.status}`);
        return (await res.json()) as T;
      };
      const [tDevices, positions] = await Promise.all([
        get<{ id: number; uniqueId: string; name?: string }[]>('/api/devices'),
        get<{ deviceId: number; fixTime?: string; deviceTime?: string; serverTime?: string; latitude: number; longitude: number; speed?: number; course?: number; accuracy?: number; attributes?: Record<string, unknown> }[]>('/api/positions'),
      ]);
      if (!positions.length) return;
      const uniq = new Map(tDevices.map((d) => [d.id, String(d.uniqueId ?? '').trim()]));
      const ours = await this.prisma.trackingDevice.findMany({
        where: {
          OR: [
            { traccarId: { in: tDevices.map((d) => d.id) } },
            { imei: { in: [...uniq.values()].filter(Boolean) } },
            { deviceCode: { in: [...uniq.values()].filter(Boolean).map((u) => u.toUpperCase()) } },
          ],
        },
      });
      for (const p of positions) {
        const u = uniq.get(p.deviceId);
        const device = ours.find((d) => d.traccarId === p.deviceId) ?? ours.find((d) => !!u && (d.imei === u || d.deviceCode === u.toUpperCase()));
        if (!device) continue;
        if (device.traccarId !== p.deviceId) {
          await this.prisma.trackingDevice.update({ where: { id: device.id }, data: { traccarId: p.deviceId } }).catch(() => undefined);
        }
        const fix = parsePoint({
          latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy, heading: p.course,
          speed: p.speed != null ? p.speed * KNOTS_TO_MS : null,
          battery: p.attributes?.batteryLevel, recordedAt: p.fixTime ?? p.deviceTime ?? p.serverTime,
        });
        if (!fix || (device.lastSeenAt && fix.recordedAt <= device.lastSeenAt)) continue;
        await this.recordDevicePoints(device, [fix], 'traccar', fix.recordedAt);
      }
    } catch (err) {
      this.log.warn(`Traccar poll failed: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }
}
