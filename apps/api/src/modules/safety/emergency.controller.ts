import { Body, Controller, Get, Injectable, Logger, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MessagingService } from '../integrations/messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { IncidentsService } from './incidents.service';
import { SafetyContext } from './safety.util';

export const ALERT_TYPES = ['Emergency', 'Drill', 'Urgent operational notice', 'Lockdown', 'Evacuation', 'Weather', 'Transport'];
export const CHANNELS = ['App + WhatsApp + SMS', 'App + WhatsApp', 'SMS only'];
const CRITICAL_TYPES = ['Emergency', 'Lockdown', 'Evacuation'];

/** Who an emergency broadcast can reach, by role. */
export const AUDIENCES: { key: string; label: string; roles: string[] }[] = [
  { key: 'parents', label: 'Parents', roles: ['parent'] },
  { key: 'teachers', label: 'Teachers', roles: ['teacher'] },
  { key: 'staff', label: 'Staff', roles: ['office', 'finance', 'hr', 'staff'] },
  { key: 'management', label: 'Management', roles: ['super_admin', 'school_admin', 'principal', 'management'] },
];

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class BroadcastDto {
  @IsIn(ALERT_TYPES, { message: 'Choose the alert type' }) alertType: string;
  @IsString() @MaxLength(1000) message: string;
  @IsArray() @ArrayMaxSize(4) @IsString({ each: true }) audiences: string[];
  @IsIn(CHANNELS, { message: 'Choose the channels' }) channels: string;
  @IsOptional() @IsBoolean() confirm?: boolean;
  @IsOptional() @IsUUID() campusId?: string;
}

interface Recipient {
  id: string;
  phone: string | null;
  pushToken: string | null;
}

/** Resolves broadcast audiences and delivers across the app, WhatsApp and SMS (bypassing personal preferences). */
@Injectable()
export class EmergencyService {
  private readonly log = new Logger(EmergencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly messaging: MessagingService,
  ) {}

  private where(key: string, campusId: string | undefined, parentIds: string[] | null): Prisma.UserWhereInput {
    const a = AUDIENCES.find((x) => x.key === key)!;
    const base: Prisma.UserWhereInput = { status: 'active', role: { key: { in: a.roles } } };
    if (!campusId) return base;
    if (key === 'parents') return { ...base, parentId: { in: parentIds ?? [] } };
    return { ...base, OR: [{ campusId }, { campusId: null }] };
  }

  /** Guardians of active students on a campus (parents have no campus of their own). */
  private async campusParentIds(campusId: string | undefined): Promise<string[] | null> {
    if (!campusId) return null;
    const links = await this.prisma.studentGuardian.findMany({ where: { student: { campusId, status: 'active' } }, select: { guardianId: true } });
    return [...new Set(links.map((l) => l.guardianId))];
  }

  async audience(campusId: string | undefined) {
    const parentIds = await this.campusParentIds(campusId);
    return Promise.all(AUDIENCES.map(async (a) => ({ key: a.key, label: a.label, count: await this.prisma.user.count({ where: this.where(a.key, campusId, parentIds) }) })));
  }

  async recipients(keys: string[], campusId: string | undefined): Promise<Recipient[]> {
    const parentIds = await this.campusParentIds(campusId);
    const users = await this.prisma.user.findMany({
      where: { OR: keys.map((k) => this.where(k, campusId, parentIds)) },
      select: { id: true, phone: true, pushToken: true, parentId: true },
    });
    // Parent accounts without a phone fall back to the guardian record's number.
    const missing = users.filter((u) => !u.phone && u.parentId).map((u) => u.parentId!);
    const guardians = missing.length ? await this.prisma.guardian.findMany({ where: { id: { in: missing } }, select: { id: true, phone: true } }) : [];
    const gPhone = new Map(guardians.map((g) => [g.id, g.phone]));
    const seen = new Set<string>();
    return users.filter((u) => !seen.has(u.id) && seen.add(u.id)).map((u) => ({ id: u.id, phone: u.phone ?? (u.parentId ? gPhone.get(u.parentId) ?? null : null), pushToken: u.pushToken }));
  }

  /** Sends in the background and records delivery counts on the broadcast. */
  deliver(broadcastId: string, recipients: Recipient[], input: { title: string; body: string; channels: string; critical: boolean; drill: boolean; campusId: string | null }) {
    const run = async () => {
      const app = input.channels.startsWith('App');
      const whatsapp = input.channels.includes('WhatsApp');
      const sms = input.channels.includes('SMS');
      const counts = { app: 0, push: 0, whatsapp: 0, sms: 0, failed: 0 };
      const link = { entityType: 'emergency_broadcast', entityId: broadcastId };
      if (app) {
        await this.notifications.notifyUsers(recipients.map((r) => r.id), {
          category: input.drill ? 'Information' : input.critical ? 'Critical' : 'Attention',
          topic: 'safety',
          module: 'safety',
          title: input.title,
          body: input.body,
          icon: 'megaphone',
          route: '/notifications',
          campusId: input.campusId,
        });
        counts.app = recipients.length;
      }
      const text = `${input.title}\n${input.body}`;
      const phones = new Set<string>();
      for (const r of recipients) {
        if (app && r.pushToken) {
          const res = await this.messaging.send('push', { to: r.pushToken, subject: input.title, body: input.body }, link);
          if (res.ok) counts.push++;
          else counts.failed++;
        }
        const phone = r.phone?.replace(/\s/g, '');
        if (!phone || phones.has(phone)) continue;
        phones.add(phone);
        if (whatsapp) {
          const res = await this.messaging.send('whatsapp', { to: phone, body: text }, link);
          if (res.ok) counts.whatsapp++;
          else counts.failed++;
        }
        if (sms) {
          const res = await this.messaging.send('sms', { to: phone, body: text }, link);
          if (res.ok) counts.sms++;
          else counts.failed++;
        }
      }
      await this.prisma.safetyBroadcast.update({ where: { id: broadcastId }, data: { delivery: { ...counts, finishedAt: new Date().toISOString() } } });
    };
    void run().catch((e) => this.log.warn(`Broadcast ${broadcastId} delivery failed: ${(e as Error).message}`));
  }
}

@Controller('emergency')
export class EmergencyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: SafetyContext,
    private readonly emergency: EmergencyService,
    private readonly incidents: IncidentsService,
    private readonly audit: AuditService,
  ) {}

  @Get('audience')
  @RequirePermissions('safety.read', 'safety.manage', 'notifications.broadcast')
  audience(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    return this.emergency.audience(this.ctx.campus(user, q.campusId));
  }

  @Get('broadcasts')
  @RequirePermissions('safety.read', 'safety.manage', 'notifications.broadcast')
  async broadcasts(@Query() q: ListQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q, 8);
    const campus = this.ctx.campus(user, q.campusId);
    const where: Prisma.SafetyBroadcastWhereInput = campus ? { OR: [{ campusId: campus }, { campusId: null }] } : {};
    const [list, total] = await Promise.all([
      this.prisma.safetyBroadcast.findMany({ where, orderBy: { sentAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.safetyBroadcast.count({ where }),
    ]);
    const campuses = await this.ctx.campusNames(list.map((b) => b.campusId));
    return paged(list.map((b) => ({
      id: b.id,
      alertType: b.alertType,
      message: b.message,
      audience: b.audiences.map((k) => AUDIENCES.find((a) => a.key === k)?.label ?? k).join(', '),
      recipients: b.recipients,
      sentAt: b.sentAt.toISOString(),
      sentByName: b.sentByName,
      campusName: b.campusId ? (campuses.get(b.campusId) ?? null) : 'All campuses',
    })), total, p);
  }

  /** Never automatic: a person composes, confirms and sends. Every broadcast is audited. */
  @Post('broadcasts')
  @RequirePermissions('notifications.broadcast', 'safety.manage')
  async send(@Body() dto: BroadcastDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const message = dto.message.trim();
    if (message.length < 10) throw fieldError('message', 'Say what is happening and what people should do (at least 10 characters)');
    const keys = [...new Set(dto.audiences)].filter((k) => AUDIENCES.some((a) => a.key === k));
    if (!keys.length) throw fieldError('audiences', 'Choose at least one audience');
    if (dto.confirm !== true) throw badRequest('Confirm the broadcast before sending');
    const campusId = this.ctx.campus(user, dto.campusId) ?? null;
    const drill = dto.alertType === 'Drill';
    const critical = !drill && CRITICAL_TYPES.includes(dto.alertType);
    const recipients = await this.emergency.recipients(keys, campusId ?? undefined);
    if (!recipients.length) throw fieldError('audiences', 'Nobody in the chosen audiences has an active account');
    const audienceLabel = keys.map((k) => AUDIENCES.find((a) => a.key === k)!.label).join(', ');

    let incidentId: string | null = null;
    if (critical) {
      const clock = await this.ctx.clock();
      const incidentCampus = campusId ?? (await this.ctx.campusFor(user));
      if (incidentCampus) {
        const incident = await this.incidents.create(user, {
          campusId: incidentCampus,
          incidentType: 'Emergency',
          summary: `${dto.alertType} broadcast: ${message}`.slice(0, 200),
          details: `${dto.alertType} broadcast sent to ${recipients.length} people (${audienceLabel}) by ${dto.channels}.\n\n${message}`,
          severity: 'Critical',
          occurredOn: clock.today(),
          ownerId: user.employeeId ?? null,
          source: 'emergency',
        }, req);
        incidentId = incident.id;
      }
    }

    const broadcast = await this.prisma.safetyBroadcast.create({
      data: {
        campusId,
        alertType: dto.alertType,
        isDrill: drill,
        message,
        audiences: keys,
        channels: dto.channels,
        recipients: recipients.length,
        incidentId,
        sentById: user.id,
        sentByName: user.fullName,
      },
    });
    const title = drill ? 'DRILL — this is a drill' : critical ? `${dto.alertType.toUpperCase()} — Holy Sai International School` : `${dto.alertType} — Holy Sai International School`;
    this.emergency.deliver(broadcast.id, recipients, { title, body: drill ? `DRILL — ${message}` : message, channels: dto.channels, critical, drill, campusId });

    await this.audit.record({
      user, action: 'publish', module: 'safety', entityType: 'emergency_broadcast', entityId: broadcast.id, campusId, req,
      description: `Sent ${drill ? 'a drill' : `a ${dto.alertType.toLowerCase()}`} broadcast to ${recipients.length} people (${audienceLabel}) by ${dto.channels}: ${message.slice(0, 200)}`,
      metadata: { alertType: dto.alertType, audiences: keys, channels: dto.channels, recipients: recipients.length },
    });
    return ok({ id: broadcast.id, recipients: recipients.length }, `Broadcast sent to ${recipients.length} recipients — logged in the audit trail`);
  }
}
