import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PtmSession } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { ok, paged } from '../../common/envelope';
import { badRequest, conflict, fieldError, forbidden, notFound } from '../../common/errors';
import { like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AudienceService } from './audience.service';
import { CommunicationsService, FAMILY_ROUTE } from './communications.service';
import type { BookingStatusDto, PtmPatchDto, PtmQuery, PtmSessionDto } from './dto';
import { ParentsService } from './parents.service';
import { dateOnly, RISK_ORDER, timeAdd, todayKey, ymd } from './parents.util';

const ACTIVE = { not: 'Cancelled' } as const;
const BOOK_TASK = 'ptm_book';
/** Engagement points by booking outcome. */
const OUTCOME_POINTS: Record<string, number> = { Booked: 0, Attended: 5, 'No-show': -5, Cancelled: 0 };
const n = (v: number) => v.toLocaleString('en-IN');
const fmtDate = (key: string) => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

type SessionWithBookings = Prisma.PtmSessionGetPayload<{ include: { bookings: true } }>;

/** Parent–teacher meetings: sessions per teacher, subject and section, split into slots that families book. */
@Injectable()
export class PtmService {
  private readonly log = new Logger(PtmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly audience: AudienceService,
    private readonly comms: CommunicationsService,
    private readonly parents: ParentsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------
  private async rows(list: PtmSession[]) {
    const ids = list.map((s) => s.id);
    const [counts, employees, sections] = await Promise.all([
      ids.length ? this.prisma.ptmBooking.groupBy({ by: ['sessionId'], where: { sessionId: { in: ids }, status: ACTIVE }, _count: { _all: true } }) : [],
      this.prisma.employee.findMany({ where: { id: { in: [...new Set(list.map((s) => s.employeeId))] } }, select: { id: true, fullName: true } }),
      this.prisma.section.findMany({ where: { id: { in: [...new Set(list.map((s) => s.sectionId))] } }, select: { id: true, name: true, class: { select: { name: true } } } }),
    ]);
    const booked = new Map(counts.map((c) => [c.sessionId, c._count._all]));
    const emp = new Map(employees.map((e) => [e.id, e.fullName]));
    const sec = new Map(sections.map((s) => [s.id, s]));
    const today = todayKey();
    return list.map((s) => {
      const b = booked.get(s.id) ?? 0;
      const section = sec.get(s.sectionId);
      return {
        id: s.id,
        employeeId: s.employeeId,
        teacher: emp.get(s.employeeId) ?? 'Teacher',
        subjectLabel: s.subjectLabel,
        sectionId: s.sectionId,
        grade: section?.class.name ?? null,
        section: section?.name ?? null,
        campusId: s.campusId,
        sessionDate: ymd(s.sessionDate)!,
        startsAt: s.startsAt,
        slotMinutes: s.slotMinutes,
        totalSlots: s.totalSlots,
        booked: b,
        free: Math.max(0, s.totalSlots - b),
        venue: s.venue,
        past: ymd(s.sessionDate)! < today,
      };
    });
  }

  /** Sessions the user may see: the header campus; teachers see their own sessions and their sections'. */
  private async scopeWhere(user: AuthUser, campusId?: string): Promise<Prisma.PtmSessionWhereInput> {
    const AND: Prisma.PtmSessionWhereInput[] = [];
    const campus = this.scope.campus(user, campusId);
    if (campus) AND.push({ campusId: campus });
    if (user.scope !== 'school') {
      const sections = await this.scope.teacherSectionIds(user);
      AND.push({ OR: [{ employeeId: user.employeeId ?? '00000000-0000-0000-0000-000000000000' }, { sectionId: { in: sections } }] });
    }
    return { AND };
  }

  private async load(id: string, user: AuthUser) {
    const s = await this.prisma.ptmSession.findUnique({ where: { id } });
    if (!s) throw notFound('PTM session');
    const visible = await this.prisma.ptmSession.count({ where: { AND: [await this.scopeWhere(user), { id }] } });
    if (!visible) throw forbidden('This session is outside your access');
    return s;
  }

  async list(user: AuthUser, q: PtmQuery) {
    const p = pageOf(q);
    const today = dateOnly(todayKey());
    const when = q.when ?? 'upcoming';
    const AND: Prisma.PtmSessionWhereInput[] = [await this.scopeWhere(user, q.campusId)];
    if (when === 'upcoming') AND.push({ sessionDate: { gte: today } });
    if (when === 'past') AND.push({ sessionDate: { lt: today } });
    if (q.q?.trim()) {
      const t = q.q.trim();
      const emps = await this.prisma.employee.findMany({ where: { fullName: like(t) }, select: { id: true }, take: 200 });
      AND.push({ OR: [{ subjectLabel: like(t) }, { venue: like(t) }, { employeeId: { in: emps.map((e) => e.id) } }] });
    }
    const where: Prisma.PtmSessionWhereInput = { AND };
    const dir: Prisma.SortOrder = q.dir === 'desc' ? 'desc' : 'asc';
    const total = await this.prisma.ptmSession.count({ where });
    if (q.sort === 'teacher') {
      const all = await this.prisma.ptmSession.findMany({ where, orderBy: [{ sessionDate: 'asc' }, { startsAt: 'asc' }] });
      const emps = await this.prisma.employee.findMany({ where: { id: { in: [...new Set(all.map((s) => s.employeeId))] } }, select: { id: true, fullName: true } });
      const name = new Map(emps.map((e) => [e.id, e.fullName]));
      all.sort((a, b) => (name.get(a.employeeId) ?? '').localeCompare(name.get(b.employeeId) ?? '') * (dir === 'desc' ? -1 : 1));
      return paged(await this.rows(all.slice(p.skip, p.skip + p.take)), total, p);
    }
    const list = await this.prisma.ptmSession.findMany({
      where,
      orderBy: [{ sessionDate: dir }, { startsAt: dir }, { subjectLabel: 'asc' }],
      skip: p.skip,
      take: p.take,
    });
    return paged(await this.rows(list), total, p);
  }

  /** Students of each section with the families' details, for unbooked lists. */
  private async sectionStudents(sectionIds: string[]) {
    return this.prisma.student.findMany({
      where: { sectionId: { in: sectionIds }, status: 'active' },
      select: {
        id: true, fullName: true, sectionId: true, risk: true,
        guardians: { orderBy: { isPrimary: 'desc' }, select: { guardian: { select: { id: true, fullName: true, phone: true } } } },
      },
      orderBy: { fullName: 'asc' },
    });
  }

  async summary(user: AuthUser, campusId?: string) {
    const sessions = await this.prisma.ptmSession.findMany({
      where: { AND: [await this.scopeWhere(user, campusId), { sessionDate: { gte: dateOnly(todayKey()) } }] },
      include: { bookings: { where: { status: ACTIVE }, select: { studentId: true } } },
      orderBy: { sessionDate: 'asc' },
    });
    const sectionIds = [...new Set(sessions.map((s) => s.sectionId))];
    const [sections, students] = await Promise.all([
      this.prisma.section.findMany({ where: { id: { in: sectionIds } }, select: { class: { select: { name: true, gradeLevel: true } } } }),
      sectionIds.length ? this.sectionStudents(sectionIds) : [],
    ]);
    const bookedStudents = new Set(sessions.flatMap((s) => s.bookings.map((b) => b.studentId)));
    const unbooked = students.filter((s) => !bookedStudents.has(s.id));
    const families = new Set<string>();
    const prioritise = new Set<string>();
    for (const s of unbooked) {
      for (const g of s.guardians) {
        families.add(g.guardian.id);
        if (s.risk === 'At Risk' || s.risk === 'Developing Risk') prioritise.add(g.guardian.id);
      }
    }
    const grades = [...new Map(sections.map((s) => [s.class.name, s.class.gradeLevel])).entries()].sort((a, b) => a[1] - b[1]).map(([name]) => name);
    return {
      sessions: sessions.length,
      totalSlots: sessions.reduce((sum, s) => sum + s.totalSlots, 0),
      booked: sessions.reduce((sum, s) => sum + s.bookings.length, 0),
      unbookedFamilies: families.size,
      unbookedStudents: unbooked.length,
      prioritiseFamilies: prioritise.size,
      grades,
      firstDate: sessions.length ? ymd(sessions[0].sessionDate) : null,
      lastDate: sessions.length ? ymd(sessions[sessions.length - 1].sessionDate) : null,
      venues: [...new Set(sessions.map((s) => s.venue).filter((v): v is string => !!v))],
    };
  }

  async detail(id: string, user: AuthUser) {
    const s = await this.load(id, user);
    const [row] = await this.rows([s]);
    const bookings = await this.prisma.ptmBooking.findMany({ where: { sessionId: id, status: ACTIVE } });
    const [students, guardians] = await Promise.all([
      this.sectionStudents([s.sectionId]),
      this.prisma.guardian.findMany({ where: { id: { in: bookings.map((b) => b.guardianId).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } }),
    ]);
    const bookedNames = await this.prisma.student.findMany({ where: { id: { in: bookings.map((b) => b.studentId) } }, select: { id: true, fullName: true, guardians: { orderBy: { isPrimary: 'desc' }, take: 1, select: { guardian: { select: { id: true, fullName: true } } } } } });
    const studentName = new Map(bookedNames.map((x) => [x.id, x]));
    const guardianName = new Map(guardians.map((g) => [g.id, g.fullName]));
    const bySlot = new Map(bookings.map((b) => [b.slotNo, b]));
    const slots = Array.from({ length: s.totalSlots }, (_, i) => {
      const slotNo = i + 1;
      const b = bySlot.get(slotNo);
      const st = b ? studentName.get(b.studentId) : undefined;
      const fallback = st?.guardians[0]?.guardian;
      return {
        slotNo,
        time: timeAdd(s.startsAt, i * s.slotMinutes),
        booking: b
          ? {
              id: b.id,
              status: b.status,
              studentId: b.studentId,
              studentName: st?.fullName ?? 'Student',
              parentId: b.guardianId ?? fallback?.id ?? null,
              parentName: (b.guardianId ? guardianName.get(b.guardianId) : undefined) ?? fallback?.fullName ?? 'Family',
            }
          : null,
      };
    });
    const booked = new Set(bookings.map((b) => b.studentId));
    const unbookedStudents = students.filter((x) => !booked.has(x.id));
    const app = await this.parents.appSet(unbookedStudents.flatMap((x) => x.guardians.map((g) => g.guardian.id)));
    const unbooked = unbookedStudents
      .map((x) => {
        const withApp = x.guardians.find((g) => app.has(g.guardian.id))?.guardian;
        const g = withApp ?? x.guardians[0]?.guardian;
        return {
          studentId: x.id,
          studentName: x.fullName,
          parentId: g?.id ?? null,
          parentName: g?.fullName ?? null,
          parentPhone: g?.phone ?? null,
          hasAppAccount: !!withApp,
          risk: x.risk,
        };
      })
      .sort((a, b) => (RISK_ORDER[a.risk] ?? 9) - (RISK_ORDER[b.risk] ?? 9) || a.studentName.localeCompare(b.studentName));
    return { ...row, slots, unbooked, lastNotifiedAt: s.lastNotifiedAt?.toISOString() ?? null };
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------
  async create(dto: PtmSessionDto, user: AuthUser, req: Request) {
    if (user.scope === 'class' && user.employeeId && dto.employeeId !== user.employeeId) throw fieldError('employeeId', 'You can only create sessions for yourself');
    const employee = await this.prisma.employee.findUnique({ where: { id: dto.employeeId } });
    if (!employee || employee.archivedAt || employee.employmentStatus === 'exited') throw fieldError('employeeId', 'Choose a teacher');
    const section = await this.prisma.section.findUnique({ where: { id: dto.sectionId }, include: { class: true } });
    if (!section) throw fieldError('sectionId', 'Choose a class and section');
    const campus = this.scope.campus(user);
    if (user.scope !== 'school' && campus && section.campusId !== campus) throw fieldError('sectionId', 'This section is on another campus');
    if (dto.sessionDate < todayKey()) throw fieldError('sessionDate', 'Choose today or a later date');
    const [h, m] = dto.startsAt.split(':').map(Number);
    const start = h * 60 + m;
    const end = start + dto.slotMinutes * dto.totalSlots;
    if (end > 24 * 60) throw fieldError('totalSlots', 'The last slot would end after midnight — use fewer slots or start earlier');
    // A teacher cannot be in two sessions at once.
    const same = await this.prisma.ptmSession.findMany({ where: { employeeId: dto.employeeId, sessionDate: dateOnly(dto.sessionDate) } });
    const clash = same.find((x) => {
      const [xh, xm] = x.startsAt.split(':').map(Number);
      const xs = xh * 60 + xm;
      return start < xs + x.slotMinutes * x.totalSlots && xs < end;
    });
    if (clash) throw fieldError('startsAt', `${employee.fullName} already has a session from ${clash.startsAt} on this date (${clash.subjectLabel})`);

    const s = await this.prisma.ptmSession.create({
      data: {
        campusId: section.campusId,
        employeeId: dto.employeeId,
        sectionId: dto.sectionId,
        subjectLabel: dto.subjectLabel,
        sessionDate: dateOnly(dto.sessionDate),
        startsAt: dto.startsAt,
        slotMinutes: dto.slotMinutes,
        totalSlots: dto.totalSlots,
        venue: dto.venue?.trim() || null,
        createdById: user.id,
        createdByName: user.fullName,
      },
    });
    await this.audit.record({
      user, action: 'create', module: 'parents', entityType: 'ptm_session', entityId: s.id,
      description: `Created PTM session ${s.subjectLabel} with ${employee.fullName} on ${dto.sessionDate} (${dto.totalSlots} × ${dto.slotMinutes} min)`, req,
    });
    // Booking opens in the parent app: tell the section's families in-app and give each a booking task.
    void this.openBooking(s, employee.fullName).catch((e) => this.log.warn(`PTM booking notice failed: ${(e as Error).message}`));
    return ok((await this.rows([s]))[0], 'PTM session created');
  }

  private async openBooking(s: PtmSession, teacher: string) {
    const links = await this.prisma.studentGuardian.findMany({ where: { student: { sectionId: s.sectionId, status: 'active' } }, select: { guardianId: true } });
    const guardianIds = [...new Set(links.map((l) => l.guardianId))];
    const users = await this.prisma.user.findMany({ where: { parentId: { in: guardianIds }, status: 'active' }, select: { id: true, parentId: true } });
    if (!users.length) return;
    const date = fmtDate(ymd(s.sessionDate)!);
    await this.notifications.notifyUsers(users.map((u) => u.id), {
      category: 'Information', topic: 'events', module: 'parents', title: `PTM booking open: ${s.subjectLabel}`,
      body: `${teacher} · ${date} from ${s.startsAt}. Book a ${s.slotMinutes}-minute slot in the parent app.`, route: FAMILY_ROUTE, campusId: s.campusId,
    });
    const row = await this.prisma.counter.upsert({ where: { key: 'tasks' }, create: { key: 'tasks', value: users.length }, update: { value: { increment: users.length } } });
    const first = row.value - users.length + 1;
    await this.prisma.task.createMany({
      data: users.map((u, i) => ({
        code: `T-${first + i}`, title: `Book a PTM slot: ${s.subjectLabel} on ${date}`, module: 'parents', assigneeId: u.id,
        dueOn: s.sessionDate, priority: 'Medium', status: 'Pending', route: FAMILY_ROUTE, entityType: BOOK_TASK, entityId: `${s.id}/${u.parentId}`,
      })),
    });
  }

  async patch(id: string, dto: PtmPatchDto, user: AuthUser, req: Request) {
    const s = await this.load(id, user);
    if (ymd(s.sessionDate)! < todayKey()) throw badRequest('This session has already taken place');
    const data: Prisma.PtmSessionUpdateInput = {};
    const notes: string[] = [];
    const slotMinutes = s.slotMinutes;
    const startsAt = dto.startsAt ?? s.startsAt;
    const totalSlots = dto.totalSlots ?? s.totalSlots;
    if (dto.totalSlots != null && dto.totalSlots !== s.totalSlots) {
      const last = await this.prisma.ptmBooking.findFirst({ where: { sessionId: id, status: ACTIVE }, orderBy: { slotNo: 'desc' }, select: { slotNo: true } });
      if (last && dto.totalSlots < last.slotNo) throw badRequest(`Slot ${last.slotNo} is booked, so the session needs at least ${last.slotNo} slots`);
      data.totalSlots = dto.totalSlots;
      notes.push(`slots ${s.totalSlots} → ${dto.totalSlots}`);
    }
    if (dto.startsAt && dto.startsAt !== s.startsAt) {
      data.startsAt = dto.startsAt;
      notes.push(`start ${s.startsAt} → ${dto.startsAt}`);
    }
    if (dto.venue !== undefined) {
      data.venue = dto.venue?.trim() || null;
      notes.push('venue');
    }
    const [h, m] = startsAt.split(':').map(Number);
    if (h * 60 + m + slotMinutes * totalSlots > 24 * 60) throw badRequest('The last slot would end after midnight');
    if (!Object.keys(data).length) throw badRequest('Nothing to change');
    const updated = await this.prisma.ptmSession.update({ where: { id }, data });
    await this.audit.record({
      user, action: 'update', module: 'parents', entityType: 'ptm_session', entityId: id,
      description: `Updated PTM session ${s.subjectLabel}: ${notes.join(', ')}`, req,
    });
    return ok((await this.rows([updated]))[0], data.totalSlots ? 'Slots updated' : 'Session updated');
  }

  /** Reminds families in the section who have not booked a slot (app + WhatsApp), at-risk students first in the list. */
  async notify(id: string, user: AuthUser, req: Request) {
    const s = await this.load(id, user);
    if (ymd(s.sessionDate)! < todayKey()) throw badRequest('This session has already taken place');
    const d = await this.detail(id, user);
    if (!d.free) throw badRequest('Every slot is booked — add slots before reminding families');
    const guardianIds = [...new Set((await this.prisma.studentGuardian.findMany({
      where: { studentId: { in: d.unbooked.map((u) => u.studentId) } },
      select: { guardianId: true },
    })).map((l) => l.guardianId))];
    if (!guardianIds.length) throw badRequest('Every family in this section has already booked');
    const channels = ['push', 'whatsapp'];
    const title = `Book your PTM slot: ${s.subjectLabel}`;
    const body = `${d.teacher} · ${fmtDate(d.sessionDate)} from ${d.startsAt}${d.venue ? ` · ${d.venue}` : ''}. ${d.free} slot${d.free === 1 ? '' : 's'} left — book in the parent app.`;
    const reach = await this.audience.reachFamilies(guardianIds, { category: 'Attention', topic: 'events', title, body, route: FAMILY_ROUTE, campusId: s.campusId, channels }, { entityType: 'ptm_session', entityId: id });
    await this.prisma.ptmSession.update({ where: { id }, data: { lastNotifiedAt: new Date(), notifyCount: { increment: 1 } } });
    await this.comms.recordBroadcast({
      channels, counterpart: `Unbooked families · ${d.grade ?? ''}${d.section ?? ''}`.trim(), subject: title, body, recipients: guardianIds.length,
      campusId: s.campusId, entityType: 'ptm_session', entityId: id, user,
    });
    await this.audit.record({
      user, action: 'update', module: 'parents', entityType: 'ptm_session', entityId: id,
      description: `Reminded ${guardianIds.length} unbooked families about PTM ${s.subjectLabel}`, req,
    });
    return ok({ notified: reach.reached }, `Reminder sent to ${n(reach.reached)} ${reach.reached === 1 ? 'family' : 'families'}`);
  }

  async setBookingStatus(bookingId: string, dto: BookingStatusDto, user: AuthUser, req: Request) {
    const b = await this.prisma.ptmBooking.findUnique({ where: { id: bookingId }, include: { session: true } });
    if (!b) throw notFound('Booking');
    await this.load(b.sessionId, user);
    if (b.status === dto.status) return ok({ id: b.id, status: b.status }, `Booking is already ${b.status}`);
    const date = ymd(b.session.sessionDate)!;
    if ((dto.status === 'Attended' || dto.status === 'No-show') && date > todayKey()) throw badRequest('Attendance can be recorded on or after the meeting date');
    if (b.status === 'Cancelled') {
      const taken = await this.prisma.ptmBooking.count({ where: { sessionId: b.sessionId, slotNo: b.slotNo, status: ACTIVE, id: { not: b.id } } });
      if (taken) throw conflict('This slot has since been booked by another family');
      if (b.slotNo > b.session.totalSlots) throw conflict('This slot no longer exists in the session');
    }
    const now = new Date();
    await this.prisma.ptmBooking.update({
      where: { id: b.id },
      data: { status: dto.status, statusChangedAt: now, statusChangedById: user.id, cancelledAt: dto.status === 'Cancelled' ? now : null },
    });
    const delta = (OUTCOME_POINTS[dto.status] ?? 0) - (OUTCOME_POINTS[b.status] ?? 0);
    if (delta) await this.parents.touchFamilyOf(b.studentId, { delta, channel: dto.status === 'Attended' ? 'Meeting' : null });
    await this.audit.record({
      user, action: 'update', module: 'parents', entityType: 'ptm_booking', entityId: b.id,
      description: `PTM ${b.session.subjectLabel} slot ${b.slotNo}: ${b.status} → ${dto.status}`, req,
    });
    return ok({ id: b.id, status: dto.status }, `Booking marked ${dto.status}`);
  }

  // ---------------------------------------------------------------------------
  // Family side (used by the family portal module for /family/ptm)
  // ---------------------------------------------------------------------------
  private async assertFamilyChild(user: AuthUser, studentId: string) {
    if (!user.parentId) throw forbidden('Only parent accounts can book PTM slots');
    const link = await this.prisma.studentGuardian.findUnique({ where: { studentId_guardianId: { studentId, guardianId: user.parentId } } });
    if (!link) throw forbidden('This child is not linked to your account');
  }

  /** Upcoming sessions for a child's section with free slots and the family's own booking. */
  async familySessions(user: AuthUser, studentId: string) {
    await this.assertFamilyChild(user, studentId);
    const student = await this.prisma.student.findUnique({ where: { id: studentId }, select: { sectionId: true } });
    if (!student) throw notFound('Student');
    const sessions: SessionWithBookings[] = await this.prisma.ptmSession.findMany({
      where: { sectionId: student.sectionId, sessionDate: { gte: dateOnly(todayKey()) } },
      include: { bookings: { where: { status: ACTIVE } } },
      orderBy: [{ sessionDate: 'asc' }, { startsAt: 'asc' }],
    });
    const rows = await this.rows(sessions);
    return sessions.map((s, i) => {
      const taken = new Set(s.bookings.map((b) => b.slotNo));
      const mine = s.bookings.find((b) => b.studentId === studentId);
      return {
        ...rows[i],
        freeSlots: Array.from({ length: s.totalSlots }, (_, k) => k + 1).filter((k) => !taken.has(k)),
        myBooking: mine ? { id: mine.id, slotNo: mine.slotNo, status: mine.status } : null,
      };
    });
  }

  /** A family books a slot for a child (one active booking per child per session). */
  async book(user: AuthUser, sessionId: string, studentId: string, slotNo: number) {
    await this.assertFamilyChild(user, studentId);
    const guardianId = user.parentId!;
    const booking = await this.prisma.$transaction(async (tx) => {
      const s = await tx.ptmSession.findUnique({ where: { id: sessionId } });
      if (!s) throw notFound('PTM session');
      const student = await tx.student.findUnique({ where: { id: studentId }, select: { sectionId: true } });
      if (!student || student.sectionId !== s.sectionId) throw badRequest('This session is for another section');
      if (ymd(s.sessionDate)! < todayKey()) throw badRequest('This session has already taken place');
      if (!Number.isInteger(slotNo) || slotNo < 1 || slotNo > s.totalSlots) throw badRequest('Choose one of the session’s slots');
      const mine = await tx.ptmBooking.findFirst({ where: { sessionId, studentId, status: ACTIVE } });
      if (mine) throw conflict(`You already have slot ${mine.slotNo} in this session — cancel it first to change the time`);
      const taken = await tx.ptmBooking.count({ where: { sessionId, slotNo, status: ACTIVE } });
      if (taken) throw conflict('That slot was just taken — please choose another');
      return tx.ptmBooking.create({ data: { sessionId, slotNo, studentId, guardianId, status: 'Booked', bookedById: user.id, bookedByName: user.fullName } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await this.parents.touch(guardianId, { delta: 5 });
    await this.notifications.completeTasksFor(BOOK_TASK, `${sessionId}/${guardianId}`);
    return { id: booking.id, slotNo: booking.slotNo, status: booking.status };
  }

  /** A family cancels its own upcoming booking; the slot is released. */
  async cancelFamilyBooking(user: AuthUser, bookingId: string) {
    if (!user.parentId) throw forbidden('Only parent accounts can cancel PTM bookings');
    const b = await this.prisma.ptmBooking.findUnique({ where: { id: bookingId }, include: { session: true } });
    if (!b) throw notFound('Booking');
    await this.assertFamilyChild(user, b.studentId);
    if (b.status !== 'Booked') throw badRequest(`This booking is ${b.status.toLowerCase()} and cannot be cancelled`);
    if (ymd(b.session.sessionDate)! < todayKey()) throw badRequest('This session has already taken place');
    const now = new Date();
    await this.prisma.ptmBooking.update({ where: { id: b.id }, data: { status: 'Cancelled', cancelledAt: now, statusChangedAt: now, statusChangedById: user.id } });
    await this.parents.touch(user.parentId, { delta: -5 });
    return { id: b.id, status: 'Cancelled' };
  }
}
