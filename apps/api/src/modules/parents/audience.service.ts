import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { MessagingService, type Channel as SendChannel } from '../integrations/messaging.service';
import { NotificationsService, type Category } from '../notifications/notifications.service';
import { audienceLabel, type Audience } from './parents.util';

export interface ReachInput {
  category: Category;
  /** circulars | events | messages | system */
  topic: string;
  title: string;
  body?: string;
  /** In-app route for parent accounts. */
  route?: string;
  campusId?: string | null;
  /** push | whatsapp | sms | email — families without the app are reached directly on WhatsApp/SMS/email. */
  channels: string[];
}

/** Resolves circular and event audiences to families (or staff accounts) and reaches them. */
@Injectable()
export class AudienceService {
  private readonly log = new Logger(AudienceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly messaging: MessagingService,
  ) {}

  label(a: Audience) {
    return audienceLabel(a);
  }

  /** Active students an audience reaches through their families. */
  studentWhere(a: Audience, campusId?: string | null): Prisma.StudentWhereInput {
    return {
      status: 'active',
      ...(campusId ? { campusId } : {}),
      ...(a.kind === 'grades' ? { section: { class: { gradeLevel: { in: a.grades ?? [] } } } } : {}),
      ...(a.kind === 'transport' ? { transport: { isNot: null } } : {}),
    };
  }

  /** Families (guardian id → their children in the audience). Empty for the staff audience. */
  async families(a: Audience, campusId?: string | null): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (a.kind === 'staff') return map;
    const links = await this.prisma.studentGuardian.findMany({
      where: { student: this.studentWhere(a, campusId) },
      select: { guardianId: true, studentId: true },
    });
    for (const l of links) map.set(l.guardianId, [...(map.get(l.guardianId) ?? []), l.studentId]);
    return map;
  }

  /** Active staff accounts (users linked to an employee record), optionally on one campus. */
  async staffUserIds(campusId?: string | null): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { status: 'active', employeeId: { not: null }, ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}) },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** Families (or staff accounts) an audience reaches right now. */
  async count(a: Audience, campusId?: string | null): Promise<number> {
    if (a.kind === 'staff') return (await this.staffUserIds(campusId)).length;
    return (await this.families(a, campusId)).size;
  }

  /** Active parent accounts for a set of families: guardian id → user ids. */
  async appUsers(guardianIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (!guardianIds.length) return map;
    const users = await this.prisma.user.findMany({ where: { parentId: { in: guardianIds }, status: 'active' }, select: { id: true, parentId: true } });
    for (const u of users) map.set(u.parentId!, [...(map.get(u.parentId!) ?? []), u.id]);
    return map;
  }

  /**
   * Sends to families: an in-app notification (delivered by each parent's preferences) for families with the app,
   * and WhatsApp/SMS (and email when chosen) straight to the guardian's contact details for the rest.
   * Returns how many families were reached through at least one route.
   */
  async reachFamilies(guardianIds: string[], input: ReachInput, link: { entityType: string; entityId: string }) {
    const ids = [...new Set(guardianIds)];
    if (!ids.length) return { reached: 0, app: 0, direct: 0 };
    const [guardians, app] = await Promise.all([
      this.prisma.guardian.findMany({ where: { id: { in: ids } }, select: { id: true, phone: true, email: true } }),
      this.appUsers(ids),
    ]);
    const channels = input.channels.length ? input.channels : ['push'];
    const userIds = [...app.values()].flat();
    if (userIds.length) {
      await this.notifications.notifyUsers(userIds, {
        category: input.category,
        topic: input.topic,
        module: 'parents',
        title: input.title,
        body: input.body,
        route: input.route,
        campusId: input.campusId ?? null,
        deliver: channels.some((c) => c !== 'email'),
      });
    }
    const direct: { channel: SendChannel; to: string }[] = [];
    let reached = 0;
    for (const g of guardians) {
      let hit = app.has(g.id);
      if (!app.has(g.id) && g.phone) {
        if (channels.includes('whatsapp')) direct.push({ channel: 'whatsapp', to: g.phone });
        else if (channels.includes('sms')) direct.push({ channel: 'sms', to: g.phone });
        hit = hit || channels.includes('whatsapp') || channels.includes('sms');
      }
      if (channels.includes('email') && g.email) {
        direct.push({ channel: 'email', to: g.email });
        hit = true;
      }
      if (hit) reached++;
    }
    if (direct.length) void this.sendDirect(direct, input, link).catch((e) => this.log.warn(`Direct delivery failed: ${(e as Error).message}`));
    return { reached, app: app.size, direct: direct.length };
  }

  /** In-app (and preference-based) notification to staff accounts. */
  async reachStaff(userIds: string[], input: Omit<ReachInput, 'channels'> & { route?: string }) {
    await this.notifications.notifyUsers(userIds, {
      category: input.category,
      topic: input.topic,
      module: 'parents',
      title: input.title,
      body: input.body,
      route: input.route,
      campusId: input.campusId ?? null,
      deliver: true,
    });
    return { reached: new Set(userIds).size };
  }

  private async sendDirect(list: { channel: SendChannel; to: string }[], input: ReachInput, link: { entityType: string; entityId: string }) {
    const text = input.body ? `${input.title}\n\n${input.body}` : input.title;
    for (const m of list) {
      await this.messaging.send(m.channel, { to: m.to, subject: input.title, body: text }, link);
    }
  }
}
