import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { SettingsService } from '../settings/settings.service';
import { dateKey, minutesOfDay, timeToMinutes } from './geo';

export type RunSession = 'morning' | 'afternoon';

/** Device contact thresholds for the GPS state shown on every device screen. */
export const GPS_ONLINE_SECONDS = 120;
export const GPS_OFFLINE_SECONDS = 600;
export const LOW_BATTERY_PCT = 20;

export interface CampusGeo {
  id: string;
  name: string;
  shortName: string;
  latitude: number | null;
  longitude: number | null;
  radiusM: number;
}

/**
 * Configurable thresholds for transport and tracking (system settings with safe fallbacks),
 * the school clock, and a short-lived campus cache for geofence checks.
 */
@Injectable()
export class TransportConfig {
  private campusCache: { at: number; rows: CampusGeo[] } | null = null;
  private gpsCache: { at: number; stale: number | null } | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly integrations: IntegrationsService,
    private readonly prisma: PrismaService,
  ) {}

  tz(): Promise<string> {
    return this.settings.get('school.timezone', 'Asia/Kolkata');
  }

  /** A location older than this is "last known" (gps integration override, else tracking.stale_after_minutes). */
  async staleAfterMinutes(): Promise<number> {
    if (!this.gpsCache || Date.now() - this.gpsCache.at > 60_000) {
      let stale: number | null = null;
      try {
        const gps = await this.integrations.get('gps');
        const v = Number(gps.config.staleAfterMinutes);
        if (gps.config.staleAfterMinutes && Number.isFinite(v) && v > 0) stale = v;
      } catch {
        stale = null;
      }
      this.gpsCache = { at: Date.now(), stale };
    }
    if (this.gpsCache.stale) return this.gpsCache.stale;
    const v = Number(await this.settings.get<number>('tracking.stale_after_minutes', 30));
    return Number.isFinite(v) && v > 0 ? v : 30;
  }

  async parentHistoryDays(): Promise<number> {
    const v = Number(await this.settings.get<number>('tracking.parent_history_days', 7));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 7;
  }

  /** Distance off the planned path that raises a deviation alert (km). */
  async deviationKm(): Promise<number> {
    const v = Number(await this.settings.get<number>('transport.deviation_alert_km', 0.5));
    return Number.isFinite(v) && v > 0 ? v : 0.5;
  }

  async speedLimitKmph(): Promise<number> {
    const v = Number(await this.settings.get<number>('transport.speed_limit_kmph', 50));
    return Number.isFinite(v) && v > 0 ? v : 50;
  }

  /** Local time from which the afternoon (home) run is the current run. */
  async afternoonFromMinutes(): Promise<number> {
    const v = timeToMinutes(await this.settings.get<string>('transport.afternoon_from', '12:00'));
    return v ?? 12 * 60;
  }

  /** Today's date key, the current run session and the minutes of day, in the school timezone. */
  async clock(at = new Date()) {
    const tz = await this.tz();
    const minutes = minutesOfDay(at, tz);
    const session: RunSession = minutes >= (await this.afternoonFromMinutes()) ? 'afternoon' : 'morning';
    return { tz, today: dateKey(at, tz), minutes, session, now: at };
  }

  async campuses(): Promise<CampusGeo[]> {
    if (!this.campusCache || Date.now() - this.campusCache.at > 60_000) {
      const rows = await this.prisma.campus.findMany({
        where: { isActive: true },
        select: { id: true, name: true, shortName: true, latitude: true, longitude: true, radiusM: true },
        orderBy: { name: 'asc' },
      });
      this.campusCache = { at: Date.now(), rows };
    }
    return this.campusCache.rows;
  }
}

export function gpsStatusOf(lastSeenAt: Date | null | undefined, now = Date.now()): 'online' | 'stale' | 'offline' | 'never' {
  if (!lastSeenAt) return 'never';
  const age = (now - lastSeenAt.getTime()) / 1000;
  return age <= GPS_ONLINE_SECONDS ? 'online' : age <= GPS_OFFLINE_SECONDS ? 'stale' : 'offline';
}
