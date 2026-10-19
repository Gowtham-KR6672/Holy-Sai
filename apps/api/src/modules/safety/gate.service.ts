import { Injectable } from '@nestjs/common';
import type { Prisma, SafetyGateEvent } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Clock, iso, SafetyContext, SENSITIVE, type StudentInfo } from './safety.util';

export interface RecordScanInput {
  studentId: string;
  direction: 'in' | 'out';
  gate: string;
  method: string;
  occurredAt?: Date;
  /** manual | reader | pickup | bus (bus-bay arrivals recorded by Transport) */
  source: 'manual' | 'reader' | 'pickup' | 'bus';
  deviceId?: string | null;
  recordedById?: string | null;
  /** false when the caller tells the guardians itself (e.g. a pickup release). */
  notify?: boolean;
}

export interface DayAgg {
  firstIn: Date | null;
  firstInMethod: string | null;
  arrivalNotified: boolean;
  lastOut: Date | null;
  lastOutGate: string | null;
  exitNotified: boolean;
  scans: number;
  last: 'in' | 'out' | null;
}

export interface GateCounts {
  expected: number;
  arrived: number;
  inside: number;
  exited: number;
  notArrived: number;
}

/** Scans within this window in the same direction are treated as one (readers often double-read). */
const DUPLICATE_MS = 60_000;
const FEED_LIMIT = 40;

/** Smart gate: records scans, tells guardians about the first arrival and departure, and computes live counts. */
@Injectable()
export class GateEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: SafetyContext,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Records one scan. The first arrival and the first departure of the day are sent to the guardians
   * (in-app and WhatsApp/SMS by preference). Re-reads within a minute are ignored.
   */
  async record(input: RecordScanInput, student?: StudentInfo): Promise<{ event: SafetyGateEvent; duplicate: boolean; notified: boolean; student: StudentInfo }> {
    const info = student ?? (await this.ctx.students([input.studentId])).get(input.studentId);
    if (!info) throw notFound('Student');
    const clock = await this.ctx.clock();
    const at = input.occurredAt ?? new Date();
    const date = clock.date(at);
    const day = clock.dayValue(date);

    const recent = await this.prisma.safetyGateEvent.findFirst({
      where: {
        studentId: info.id,
        direction: input.direction,
        occurredAt: { gte: new Date(at.getTime() - DUPLICATE_MS), lte: new Date(at.getTime() + DUPLICATE_MS) },
      },
    });
    if (recent) return { event: recent, duplicate: true, notified: false, student: info };

    const alreadyTold = await this.prisma.safetyGateEvent.count({
      where: { studentId: info.id, day, direction: input.direction, parentNotifiedAt: { not: null } },
    });
    const isToday = date === clock.today();
    const first = alreadyTold === 0 && isToday;
    const event = await this.prisma.safetyGateEvent.create({
      data: {
        campusId: info.campusId,
        studentId: info.id,
        direction: input.direction,
        gate: input.gate,
        method: input.method,
        occurredAt: at,
        day,
        parentNotifiedAt: first ? new Date() : null,
        source: input.source,
        deviceId: input.deviceId ?? null,
        recordedById: input.recordedById ?? null,
      },
    });

    const notified = first && input.notify !== false;
    if (notified) {
      const time = clock.time(at);
      await this.notifications.notifyGuardians(info.id, {
        category: 'Information',
        topic: 'safety',
        module: 'safety',
        title: input.direction === 'in' ? `${info.firstName} arrived at school` : `${info.firstName} left school`,
        body: input.direction === 'in'
          ? `Entered through the ${input.gate} at ${time} (${input.method} verified).`
          : `Exited through the ${input.gate} at ${time}.`,
        route: '/parent-360?tab=safety',
        campusId: info.campusId,
        deliver: true,
      });
    }
    return { event, duplicate: false, notified, student: info };
  }

  /** Row shape for the "All scans" table. */
  row(e: SafetyGateEvent, s: StudentInfo | undefined) {
    return {
      id: e.id,
      occurredAt: e.occurredAt.toISOString(),
      direction: e.direction as 'in' | 'out',
      gate: e.gate,
      method: e.method,
      parentNotifiedAt: iso(e.parentNotifiedAt),
      studentId: e.studentId,
      admissionNo: s?.admissionNo ?? '',
      fullName: s?.fullName ?? 'Unknown student',
      grade: s?.grade ?? null,
      section: s?.section ?? null,
      campusName: s?.campusName ?? '',
    };
  }

  /** Today's scans for one child, oldest first (family portal "gateToday"). */
  async todayFor(studentId: string): Promise<{ gate: string; direction: 'in' | 'out'; method: string; occurredAt: string }[]> {
    const clock = await this.ctx.clock();
    const rows = await this.prisma.safetyGateEvent.findMany({
      where: { studentId, day: clock.dayValue(clock.today()) },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map((r) => ({ gate: r.gate, direction: r.direction as 'in' | 'out', method: r.method, occurredAt: r.occurredAt.toISOString() }));
  }

  /** Per-student aggregates for a day. */
  aggregate(events: SafetyGateEvent[]): Map<string, DayAgg> {
    const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const map = new Map<string, DayAgg>();
    for (const e of sorted) {
      let a = map.get(e.studentId);
      if (!a) {
        a = { firstIn: null, firstInMethod: null, arrivalNotified: false, lastOut: null, lastOutGate: null, exitNotified: false, scans: 0, last: null };
        map.set(e.studentId, a);
      }
      a.scans++;
      a.last = e.direction as 'in' | 'out';
      if (e.direction === 'in') {
        if (!a.firstIn) {
          a.firstIn = e.occurredAt;
          a.firstInMethod = e.method;
        }
        if (e.parentNotifiedAt) a.arrivalNotified = true;
      } else {
        a.lastOut = e.occurredAt;
        a.lastOutGate = e.gate;
        if (e.parentNotifiedAt) a.exitNotified = true;
      }
    }
    return map;
  }

  /** Active students in scope and their scans on a day. */
  async day(user: AuthUser, campusId: string | undefined, date: string, clock?: Clock) {
    const c = clock ?? (await this.ctx.clock());
    const studentWhere = await this.ctx.studentWhere(user, campusId);
    const students = await this.prisma.student.findMany({ where: { AND: [studentWhere, { status: 'active' }] }, select: { id: true } });
    const ids = new Set(students.map((s) => s.id));
    const recordWhere = await this.ctx.recordWhere(user, campusId);
    const events = await this.prisma.safetyGateEvent.findMany({ where: { ...recordWhere, day: c.dayValue(date) }, orderBy: { occurredAt: 'asc' } });
    return { ids, events, agg: this.aggregate(events) };
  }

  counts(ids: Set<string>, agg: Map<string, DayAgg>): GateCounts {
    let arrived = 0;
    let inside = 0;
    let exited = 0;
    let seen = 0;
    for (const id of ids) {
      const a = agg.get(id);
      if (!a) continue;
      seen++;
      if (a.firstIn) arrived++;
      if (a.last === 'in') inside++;
      else if (a.last === 'out') exited++;
    }
    return { expected: ids.size, arrived, inside, exited, notArrived: Math.max(0, ids.size - seen) };
  }

  /** Live counts for dashboards (expected, arrived, inside, exited, not yet arrived). */
  async countsToday(user: AuthUser, campusId?: string): Promise<GateCounts> {
    const clock = await this.ctx.clock();
    const { ids, agg } = await this.day(user, campusId, clock.today(), clock);
    return this.counts(ids, agg);
  }

  /** Smart Gate dashboard. */
  async summary(user: AuthUser, campusId?: string) {
    const clock = await this.ctx.clock();
    const today = clock.today();
    const { start, end } = clock.bounds(today);
    const now = new Date();
    const { ids, events, agg } = await this.day(user, campusId, today, clock);
    const counts = this.counts(ids, agg);
    const campus = this.ctx.campus(user, campusId);
    const campusWhere = campus ? { campusId: campus } : {};
    const recordWhere = await this.ctx.recordWhere(user, campusId);

    const [visitorsOnSite, visitorsExpected, awaitingPickup, heldOpen, pendingAuthorisations, visitorsToday, gateCfg] = await Promise.all([
      this.prisma.safetyVisitor.count({ where: { ...campusWhere, status: 'Inside' } }),
      this.prisma.safetyVisitor.count({ where: { ...campusWhere, status: 'Expected', checkedInAt: { gte: now, lt: end } } }),
      this.prisma.safetyInfirmaryVisit.count({ where: { ...recordWhere, outcome: 'Awaiting pickup', visitedAt: { gte: start, lt: end } } }),
      this.prisma.safetyPickupEvent.count({ where: { ...recordWhere, outcome: 'held', resolved: false, day: clock.dayValue(today) } }),
      this.prisma.safetyPickupAuthorisation.count({ where: { ...recordWhere, status: 'Pending' } }),
      this.prisma.safetyVisitor.count({ where: { ...campusWhere, status: { in: ['Inside', 'Completed'] }, checkedInAt: { gte: start, lt: end } } }),
      this.ctx.gates(),
    ]);

    const gates = gateCfg.gates.map((gate) => {
      const list = events.filter((e) => e.gate === gate);
      const last = list.length ? list[list.length - 1].occurredAt : null;
      const recent = last && now.getTime() - last.getTime() < 30 * 60_000;
      const extra = gate === 'Visitor Gate' && visitorsToday ? ` · ${visitorsToday} visitor${visitorsToday === 1 ? '' : 's'}` : '';
      if (!list.length) {
        return {
          gate,
          tone: extra ? 'info' : 'neutral',
          detail: `No student scans yet today${extra}${gateCfg.readers ? ' · readers connected' : ' · manual entry'}`,
        };
      }
      return {
        gate,
        tone: recent ? 'success' : 'info',
        detail: `${list.length} scan${list.length === 1 ? '' : 's'} today · last ${clock.time(last!)}${extra}`,
      };
    });

    return {
      arrived: counts.arrived,
      inside: counts.inside,
      exited: counts.exited,
      notArrived: counts.notArrived,
      expected: counts.expected,
      visitorsOnSite,
      visitorsExpected,
      pendingPickup: awaitingPickup + heldOpen,
      pendingAuthorisations,
      gates,
      arrivals: this.arrivals(clock, today, [...agg.entries()].filter(([id]) => ids.has(id)).map(([, a]) => a.firstIn).filter((d): d is Date => !!d)),
      generatedAt: now.toISOString(),
    };
  }

  /** Cumulative first arrivals every 15 minutes through the morning. */
  private arrivals(clock: Clock, date: string, firsts: Date[]) {
    const STEP = 15 * 60_000;
    const minutes = (d: Date) => {
      const [h, m] = clock.time(d).split(':').map(Number);
      return h * 60 + m;
    };
    const mins = firsts.map(minutes).sort((a, b) => a - b);
    let from = 7 * 60;
    let to = 9 * 60 + 30;
    if (mins.length) {
      from = Math.min(from, Math.floor(mins[0] / 15) * 15);
      to = Math.max(to, Math.ceil(mins[mins.length - 1] / 15) * 15);
    }
    if (date === clock.today()) {
      const nowMin = Math.ceil(minutes(new Date()) / 15) * 15;
      to = Math.max(from + 60, Math.min(to, Math.max(nowMin, mins.length ? Math.ceil(mins[mins.length - 1] / 15) * 15 : 0)));
    }
    from = Math.max(0, from);
    to = Math.min(24 * 60, to);
    const labels: string[] = [];
    const values: number[] = [];
    let i = 0;
    for (let t = from; t <= to; t += STEP / 60_000) {
      while (i < mins.length && mins[i] <= t) i++;
      labels.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
      values.push(i);
    }
    return { labels, values };
  }

  /** Today's activity: scans, collections, visitors, incidents and broadcasts, newest first. */
  async feed(user: AuthUser, campusId?: string) {
    const clock = await this.ctx.clock();
    const today = clock.today();
    const { start, end } = clock.bounds(today);
    const campus = this.ctx.campus(user, campusId);
    const campusWhere = campus ? { campusId: campus } : {};
    const recordWhere = await this.ctx.recordWhere(user, campusId);
    const sensitive = user.permissions.has(SENSITIVE);

    const [scans, pickups, visitors, incidents, broadcasts] = await Promise.all([
      this.prisma.safetyGateEvent.findMany({ where: { ...recordWhere, day: clock.dayValue(today) }, orderBy: { occurredAt: 'desc' }, take: FEED_LIMIT }),
      this.prisma.safetyPickupEvent.findMany({
        where: { ...recordWhere, day: clock.dayValue(today) },
        orderBy: { occurredAt: 'desc' },
        take: FEED_LIMIT,
        include: { incident: { select: { code: true } }, authorisation: { select: { relation: true } } },
      }),
      this.prisma.safetyVisitor.findMany({
        where: {
          ...campusWhere,
          OR: [
            { status: { in: ['Inside', 'Completed'] }, checkedInAt: { gte: start, lt: end } },
            { checkedOutAt: { gte: start, lt: end } },
            { status: 'Denied', deniedAt: { gte: start, lt: end } },
          ],
        },
        orderBy: { checkedInAt: 'desc' },
        take: FEED_LIMIT,
      }),
      this.prisma.safetyIncident.findMany({ where: { ...campusWhere, createdAt: { gte: start, lt: end } }, orderBy: { createdAt: 'desc' }, take: FEED_LIMIT }),
      this.prisma.safetyBroadcast.findMany({
        where: { ...(campus ? { OR: [{ campusId: campus }, { campusId: null }] } : {}), sentAt: { gte: start, lt: end } },
        orderBy: { sentAt: 'desc' },
        take: 10,
      }),
    ]);

    const students = await this.ctx.students([...scans.map((s) => s.studentId), ...pickups.map((p) => p.studentId), ...incidents.map((i) => i.studentId)]);
    const hosts = await this.ctx.employees(visitors.map((v) => v.hostId));

    type Item = { id: string; at: string; kind: string; icon: string; actor: string | null; studentId: string | null; text: string; meta: string | null; tone?: string };
    const items: Item[] = [];

    for (const e of scans) {
      const s = students.get(e.studentId);
      items.push({
        id: `scan-${e.id}`,
        at: e.occurredAt.toISOString(),
        kind: e.direction === 'in' ? 'entry' : 'exit',
        icon: e.direction === 'in' ? 'door' : 'logout',
        actor: s?.fullName ?? 'A student',
        studentId: s ? e.studentId : null,
        text: e.direction === 'in' ? `arrived through the ${e.gate}` : `left through the ${e.gate}`,
        meta: [e.method, s ? [s.grade, s.section].filter(Boolean).join('') : null, e.parentNotifiedAt ? 'parent notified' : null].filter(Boolean).join(' · ') || null,
        tone: 'info',
      });
    }
    for (const p of pickups) {
      const s = students.get(p.studentId);
      const held = p.outcome === 'held';
      items.push({
        id: `pickup-${p.id}`,
        at: p.occurredAt.toISOString(),
        kind: held ? 'pickup_held' : 'pickup',
        icon: held ? 'alert' : 'userCheck',
        actor: s?.fullName ?? 'A student',
        studentId: s ? p.studentId : null,
        text: held
          ? `collection held: ${p.personName} is not authorised${p.resolved ? ' (resolved)' : ''}`
          : `collected by ${p.personName}${p.authorisation?.relation ? ` (${p.authorisation.relation})` : ''}`,
        meta: [p.gate, held ? p.incident?.code : p.method, held && !p.resolved ? 'awaiting parent' : null].filter(Boolean).join(' · ') || null,
        tone: held && !p.resolved ? 'critical' : held ? 'warning' : 'success',
      });
    }
    for (const v of visitors) {
      const host = v.hostId ? hosts.get(v.hostId)?.fullName : null;
      if (v.status === 'Denied') {
        items.push({ id: `visitor-d-${v.id}`, at: (v.deniedAt ?? v.updatedAt).toISOString(), kind: 'visitor_denied', icon: 'x', actor: v.fullName, studentId: null, text: 'was denied entry', meta: v.purpose, tone: 'warning' });
        continue;
      }
      if (v.checkedInAt >= start && v.checkedInAt < end) {
        items.push({
          id: `visitor-in-${v.id}`,
          at: v.checkedInAt.toISOString(),
          kind: 'visitor_in',
          icon: 'idCard',
          actor: v.fullName,
          studentId: null,
          text: host ? `checked in to meet ${host}` : 'checked in',
          meta: [`Badge ${v.badgeNo}`, v.purpose].join(' · '),
          tone: 'info',
        });
      }
      if (v.checkedOutAt && v.checkedOutAt >= start && v.checkedOutAt < end) {
        items.push({ id: `visitor-out-${v.id}`, at: v.checkedOutAt.toISOString(), kind: 'visitor_out', icon: 'logout', actor: v.fullName, studentId: null, text: 'checked out', meta: `Badge ${v.badgeNo} returned`, tone: 'info' });
      }
    }
    for (const i of incidents) {
      const hidden = i.isConfidential && !sensitive;
      const s = i.studentId ? students.get(i.studentId) : undefined;
      items.push({
        id: `incident-${i.id}`,
        at: i.createdAt.toISOString(),
        kind: 'incident',
        icon: i.severity === 'Critical' ? 'alert' : 'shield',
        actor: null,
        studentId: null,
        text: hidden ? `${i.code} logged: confidential ${i.incidentType.toLowerCase()} record` : `${i.code} logged: ${i.summary}`,
        meta: [i.incidentType, i.severity, hidden ? null : s?.fullName].filter(Boolean).join(' · ') || null,
        tone: i.severity === 'Critical' && i.status !== 'Closed' ? 'critical' : i.severity === 'Attention' ? 'warning' : 'info',
      });
    }
    for (const b of broadcasts) {
      items.push({
        id: `broadcast-${b.id}`,
        at: b.sentAt.toISOString(),
        kind: 'broadcast',
        icon: 'megaphone',
        actor: b.sentByName,
        studentId: null,
        text: `sent ${b.isDrill ? 'a drill' : `a ${b.alertType.toLowerCase()}`} broadcast to ${b.recipients} people`,
        meta: b.channels,
        tone: !b.isDrill && ['Emergency', 'Lockdown', 'Evacuation'].includes(b.alertType) ? 'critical' : 'info',
      });
    }
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, FEED_LIMIT);
  }

  /** "By student" gate log for a day. */
  async log(user: AuthUser, q: { campusId?: string; date: string; status?: string; classId?: string; q?: string }) {
    const clock = await this.ctx.clock();
    const studentWhere = await this.ctx.studentWhere(user, q.campusId);
    const where: Prisma.StudentWhereInput = {
      AND: [
        studentWhere,
        { status: 'active' },
        q.classId ? { section: { classId: q.classId } } : {},
        q.q ? { OR: [{ fullName: { contains: q.q.trim(), mode: 'insensitive' } }, { admissionNo: { contains: q.q.trim(), mode: 'insensitive' } }] } : {},
      ],
    };
    const students = await this.ctx.findStudents(where);
    const recordWhere = await this.ctx.recordWhere(user, q.campusId);
    const events = await this.prisma.safetyGateEvent.findMany({ where: { ...recordWhere, day: clock.dayValue(q.date) } });
    const agg = this.aggregate(events);
    const rows = students.map((s) => {
      const a = agg.get(s.id);
      const status: 'Inside' | 'Exited' | 'Not arrived' = !a ? 'Not arrived' : a.last === 'in' ? 'Inside' : 'Exited';
      return {
        id: s.id,
        admissionNo: s.admissionNo,
        fullName: s.fullName,
        grade: s.grade,
        section: s.section,
        campusName: s.campusName,
        firstIn: iso(a?.firstIn),
        lastOut: iso(a?.lastOut),
        entryMethod: a?.firstInMethod ?? null,
        exitGate: a?.lastOutGate ?? null,
        arrivalNotified: !!a?.arrivalNotified,
        exitNotified: !!a?.exitNotified,
        scans: a?.scans ?? 0,
        status,
        routeCode: s.routeCode,
      };
    });
    return q.status ? rows.filter((r) => r.status === q.status) : rows;
  }
}
