import { Injectable } from '@nestjs/common';
import type { CommEvent, Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { AudienceService } from './audience.service';
import { CommunicationsService, FAMILY_ROUTE } from './communications.service';
import type { EventDto, EventQuery } from './dto';
import { addDays, audienceOf, dateOnly, iso, parseAudience, todayKey, ymd } from './parents.util';

const n = (v: number) => v.toLocaleString('en-IN');
const fmtDate = (key: string) => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Events on or after `key` (multi-day events count until their last day). */
const endsOnOrAfter = (key: string): Prisma.CommEventWhereInput => ({
  OR: [{ endsOn: { gte: dateOnly(key) } }, { endsOn: null, startsOn: { gte: dateOnly(key) } }],
});
const endedBefore = (key: string): Prisma.CommEventWhereInput => ({
  OR: [{ endsOn: { lt: dateOnly(key) } }, { endsOn: null, startsOn: { lt: dateOnly(key) } }],
});

/** The school calendar: School, Academic, Sports, Cultural, PTM and Holiday events, published to families. */
@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly audience: AudienceService,
    private readonly comms: CommunicationsService,
  ) {}

  private async rows(list: CommEvent[]) {
    const campusIds = [...new Set(list.map((e) => e.campusId).filter((x): x is string => !!x))];
    const campuses = campusIds.length ? await this.prisma.campus.findMany({ where: { id: { in: campusIds } }, select: { id: true, name: true } }) : [];
    const campus = new Map(campuses.map((c) => [c.id, c.name]));
    return list.map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      eventType: e.eventType,
      startsOn: ymd(e.startsOn)!,
      endsOn: ymd(e.endsOn),
      startsAt: e.startsAt,
      venue: e.venue,
      audience: e.audienceLabel,
      audienceFilter: audienceOf(e.audience),
      campusId: e.campusId,
      campus: e.campusId ? campus.get(e.campusId) ?? null : null,
      status: e.status,
      notifiedAt: iso(e.notifiedAt),
      createdBy: e.createdByName,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  private async row(e: CommEvent) {
    return (await this.rows([e]))[0];
  }

  private scopeWhere(user: AuthUser, campusId?: string): Prisma.CommEventWhereInput {
    const campus = this.scope.campus(user, campusId);
    return campus ? { OR: [{ campusId: campus }, { campusId: null }] } : {};
  }

  private async load(id: string, user: AuthUser) {
    const e = await this.prisma.commEvent.findUnique({ where: { id } });
    if (!e) throw notFound('Event');
    if (e.campusId && user.scope !== 'school' && user.campusId && user.campusId !== e.campusId) throw forbidden('This event is for another campus');
    return e;
  }

  async list(user: AuthUser, q: EventQuery) {
    const p = pageOf(q, 20);
    const today = todayKey();
    const when = q.when ?? 'upcoming';
    const AND: Prisma.CommEventWhereInput[] = [this.scopeWhere(user, q.campusId)];
    if (when === 'upcoming') AND.push(endsOnOrAfter(today));
    if (when === 'past') AND.push(endedBefore(today));
    if (q.type) AND.push({ eventType: q.type });
    if (q.status) AND.push({ status: q.status });
    if (q.from) AND.push(endsOnOrAfter(q.from));
    if (q.to) AND.push({ startsOn: { lte: dateOnly(q.to) } });
    if (q.q?.trim()) {
      const t = q.q.trim();
      AND.push({ OR: [{ title: like(t) }, { description: like(t) }, { venue: like(t) }] });
    }
    const where: Prisma.CommEventWhereInput = { AND };
    const d: Prisma.SortOrder = when === 'past' ? 'desc' : 'asc';
    const [list, total] = await Promise.all([
      this.prisma.commEvent.findMany({ where, orderBy: [{ startsOn: d }, { startsAt: { sort: d, nulls: 'first' } }, { title: 'asc' }], skip: p.skip, take: p.take }),
      this.prisma.commEvent.count({ where }),
    ]);
    return paged(await this.rows(list), total, p);
  }

  async summary(user: AuthUser, campusId?: string) {
    const today = todayKey();
    const base = this.scopeWhere(user, campusId);
    const upcoming = endsOnOrAfter(today);
    const [up, next30, drafts, cancelled] = await Promise.all([
      this.prisma.commEvent.count({ where: { AND: [base, upcoming, { status: 'Published' }] } }),
      this.prisma.commEvent.count({ where: { AND: [base, upcoming, { status: 'Published', startsOn: { lte: dateOnly(addDays(today, 30)) } }] } }),
      this.prisma.commEvent.count({ where: { AND: [base, upcoming, { status: 'Draft' }] } }),
      this.prisma.commEvent.count({ where: { AND: [base, upcoming, { status: 'Cancelled' }] } }),
    ]);
    return { upcoming: up, next30Days: next30, drafts, cancelled };
  }

  private async fields(dto: EventDto, isNew: boolean) {
    const audience = parseAudience(dto.audience, 'audience');
    if (isNew && dto.startsOn < todayKey()) throw fieldError('startsOn', 'New events cannot start in the past');
    const endsOn = dto.endsOn || null;
    if (endsOn && endsOn < dto.startsOn) throw fieldError('endsOn', 'End date must be on or after the start date');
    const campusId = dto.campusId ?? null;
    if (campusId && !(await this.prisma.campus.count({ where: { id: campusId } }))) throw fieldError('campusId', 'Choose a campus');
    return {
      title: dto.title,
      description: dto.description?.trim() || null,
      eventType: dto.eventType,
      startsOn: dateOnly(dto.startsOn),
      endsOn: endsOn && endsOn !== dto.startsOn ? dateOnly(endsOn) : null,
      startsAt: dto.startsAt || null,
      venue: dto.venue?.trim() || null,
      audience: audience as unknown as Prisma.InputJsonValue,
      audienceLabel: this.audience.label(audience),
      campusId,
    };
  }

  async create(dto: EventDto, user: AuthUser, req: Request) {
    const e = await this.prisma.commEvent.create({
      data: { ...(await this.fields(dto, true)), status: dto.status ?? 'Published', createdById: user.id, createdByName: user.fullName },
    });
    await this.audit.record({
      user, action: e.status === 'Published' ? 'publish' : 'create', module: 'parents', entityType: 'event', entityId: e.id,
      description: `${e.status === 'Published' ? 'Published' : 'Drafted'} event “${e.title}” on ${ymd(e.startsOn)}`, req,
    });
    return ok(await this.row(e), e.status === 'Published' ? 'Event created' : 'Event saved as draft');
  }

  async update(id: string, dto: EventDto, user: AuthUser, req: Request) {
    const existing = await this.load(id, user);
    if (existing.status === 'Cancelled') throw badRequest('A cancelled event cannot be edited');
    const e = await this.prisma.commEvent.update({ where: { id }, data: { ...(await this.fields(dto, false)), status: dto.status ?? existing.status } });
    await this.audit.record({
      user, action: 'update', module: 'parents', entityType: 'event', entityId: id,
      description: `Updated event “${e.title}”${existing.status !== e.status ? ` (${existing.status} → ${e.status})` : ''}`, req,
    });
    return ok(await this.row(e), 'Event updated');
  }

  private whenText(e: CommEvent) {
    const s = ymd(e.startsOn)!;
    const end = ymd(e.endsOn);
    return `${fmtDate(s)}${end && end !== s ? ` – ${fmtDate(end)}` : ''}${e.startsAt ? ` at ${e.startsAt}` : ''}`;
  }

  /** Sends the event to its audience. Returns the number of families (or staff) reached. */
  private async announce(e: CommEvent, title: string, body: string, user: AuthUser) {
    const a = audienceOf(e.audience);
    if (a.kind === 'staff') {
      const ids = await this.audience.staffUserIds(e.campusId);
      if (ids.length) await this.audience.reachStaff(ids, { category: 'Information', topic: 'events', title, body, route: '/events', campusId: e.campusId });
      return ids.length;
    }
    const families = [...(await this.audience.families(a, e.campusId)).keys()];
    if (!families.length) return 0;
    const channels = ['push', 'whatsapp'];
    await this.audience.reachFamilies(families, { category: 'Information', topic: 'events', title, body, route: FAMILY_ROUTE, campusId: e.campusId, channels }, { entityType: 'event', entityId: e.id });
    await this.comms.recordBroadcast({ channels, counterpart: e.audienceLabel, subject: title, body, recipients: families.length, campusId: e.campusId, entityType: 'event', entityId: e.id, user });
    return families.length;
  }

  async notify(id: string, user: AuthUser, req: Request) {
    const e = await this.load(id, user);
    if (e.status !== 'Published') throw badRequest(e.status === 'Draft' ? 'Publish the event before notifying families' : 'A cancelled event cannot be announced');
    if ((ymd(e.endsOn) ?? ymd(e.startsOn)!) < todayKey()) throw badRequest('This event has already taken place');
    const body = [this.whenText(e), e.venue, e.description].filter(Boolean).join(' · ');
    const count = await this.announce(e, `${e.eventType === 'Holiday' ? 'Holiday' : 'Event'}: ${e.title}`, body, user);
    if (!count) throw badRequest('Nobody is in this audience yet, so no one was notified');
    const updated = await this.prisma.commEvent.update({ where: { id }, data: { notifiedAt: new Date(), notifyCount: { increment: 1 } } });
    await this.audit.record({
      user, action: 'publish', module: 'parents', entityType: 'event', entityId: id,
      description: `Notified ${count} ${audienceOf(e.audience).kind === 'staff' ? 'staff' : 'families'} about “${e.title}”`, req,
    });
    const who = audienceOf(e.audience).kind === 'staff' ? 'staff' : count === 1 ? 'family' : 'families';
    return ok(await this.row(updated), `Notified ${n(count)} ${who}`);
  }

  async cancel(id: string, user: AuthUser, req: Request) {
    const e = await this.load(id, user);
    if (e.status === 'Cancelled') throw badRequest('This event is already cancelled');
    const upcoming = (ymd(e.endsOn) ?? ymd(e.startsOn)!) >= todayKey();
    const updated = await this.prisma.commEvent.update({
      where: { id },
      data: { status: 'Cancelled', cancelledAt: new Date(), cancelledByName: user.fullName },
    });
    let told = 0;
    if (e.status === 'Published' && upcoming) {
      told = await this.announce(e, `Cancelled: ${e.title}`, `${this.whenText(e)} — this event has been cancelled.`, user);
    }
    await this.audit.record({
      user, action: 'update', module: 'parents', entityType: 'event', entityId: id,
      description: `Cancelled event “${e.title}”${told ? ` and notified ${told}` : ''}`, req,
    });
    return ok(await this.row(updated), told ? `Event cancelled · ${n(told)} notified` : 'Event cancelled');
  }

  // ---------------------------------------------------------------------------
  // Family side (used by the family portal module for /family/events)
  // ---------------------------------------------------------------------------
  /** Published events for the signed-in parent's children (their campuses, grades and transport), from 30 days ago. */
  async familyEvents(user: AuthUser) {
    const ids = await this.scope.familyStudentIds(user);
    if (!ids.length) return [];
    const kids = await this.prisma.student.findMany({
      where: { id: { in: ids }, status: 'active' },
      select: { campusId: true, section: { select: { class: { select: { gradeLevel: true } } } }, transport: { select: { routeId: true } } },
    });
    const campuses = [...new Set(kids.map((k) => k.campusId))];
    const grades = new Set(kids.map((k) => k.section.class.gradeLevel));
    const transport = kids.some((k) => !!k.transport);
    const list = await this.prisma.commEvent.findMany({
      where: { status: { in: ['Published', 'Cancelled'] }, OR: [{ campusId: null }, { campusId: { in: campuses } }], AND: [endsOnOrAfter(addDays(todayKey(), -30))] },
      orderBy: [{ startsOn: 'asc' }, { startsAt: { sort: 'asc', nulls: 'first' } }],
      take: 200,
    });
    const visible = list.filter((e) => {
      const a = audienceOf(e.audience);
      if (a.kind === 'staff') return false;
      if (a.kind === 'grades') return (a.grades ?? []).some((g) => grades.has(g));
      if (a.kind === 'transport') return transport;
      return true;
    });
    return this.rows(visible);
  }
}
