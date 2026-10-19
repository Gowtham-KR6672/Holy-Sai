import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { type AuthUser, can } from '../../common/auth-user';
import { notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { FinanceLedgerService } from '../finance/ledger.service';
import { type Category, TONE } from '../notifications/notifications.service';
import { EventsService } from '../parents/events.service';
import { ParentsService } from '../parents/parents.service';
import { GateEventsService } from '../safety/gate.service';
import { PickupService } from '../safety/pickup.service';
import { TransportConfig } from '../transport/transport-config.service';
import { TransportService } from '../transport/transport.service';
import type { ChildAccess } from './family-access.service';

/** Payments a family sees as receipts (initiated or failed online attempts are not receipts). */
export const RECEIPT_STATUSES = ['Success', 'Refunded'];
/** Staff who may see a child's live location (the tracking screens' permissions). */
export const TRACK_STAFF = ['tracking.read_all', 'tracking.read_assigned', 'tracking.manage'];

const CHILD_SELECT = {
  id: true,
  admissionNo: true,
  firstName: true,
  lastName: true,
  fullName: true,
  campusId: true,
  sectionId: true,
  house: true,
  photoUrl: true,
  status: true,
  discontinuedOn: true,
  trackingStatus: true,
  attendancePct: true,
  averageScore: true,
  scoreTrend: true,
  risk: true,
  campus: { select: { name: true } },
  section: { select: { name: true, classId: true, class: { select: { name: true } } } },
  transport: { select: { route: { select: { code: true, name: true } } } },
} satisfies Prisma.StudentSelect;
type ChildPick = Prisma.StudentGetPayload<{ select: typeof CHILD_SELECT }>;

const round1 = (n: number) => Math.round(n * 10) / 10;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const dayValue = (key: string) => new Date(`${key}T00:00:00.000Z`);
const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Shown homework status: open homework reads "Closing today" on its due date and "Overdue" after it. */
const homeworkStatus = (status: string, due: string, today: string) => (status !== 'Open' ? status : due < today ? 'Overdue' : due === today ? 'Closing today' : 'Open');

export interface ChildLink {
  student: ChildPick;
  relationship: string;
  isPrimary: boolean;
}

/**
 * The family portal's read models: the parent's children (StudentRow plus portal fields), a child's day
 * (gate, bus, homework, fees, updates, pickup), fees and receipts, and the safety card. Data comes from the
 * owning modules' services (finance ledger, safety gate and pickup, transport, parents events) and tables.
 */
@Injectable()
export class FamilyService {
  private readonly log = new Logger('Family');

  constructor(
    private readonly prisma: PrismaService,
    private readonly parents: ParentsService,
    private readonly ledger: FinanceLedgerService,
    private readonly gate: GateEventsService,
    private readonly pickup: PickupService,
    private readonly transport: TransportService,
    private readonly transportConfig: TransportConfig,
    private readonly events: EventsService,
  ) {}

  /** Runs a secondary part of a screen; a failure there is logged and replaced by the empty value. */
  private async safe<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.log.warn(`${what} unavailable: ${(err as Error).message}`);
      return fallback;
    }
  }

  // ---------------------------------------------------------------------------
  // Children
  // ---------------------------------------------------------------------------

  /** Child rows as Parent 360 shows them: StudentRow plus relationship, tracking state and last location time. */
  async childRows(user: AuthUser, viewer: 'family' | 'staff', links: ChildLink[]) {
    if (!links.length) return [];
    const ids = links.map((l) => l.student.id);
    const clock = await this.transportConfig.clock();
    // Secondary figures never stop the portal from loading: a failing source reads as "not available yet".
    const [attendance, fees, states, staleMinutes] = await Promise.all([
      this.safe('Today’s attendance', () => this.prisma.studentAttendance.findMany({
        where: { studentId: { in: ids }, date: dayValue(clock.today) },
        select: { studentId: true, sectionId: true, status: true },
      }), []),
      this.safe('Fee status', () => this.ledger.accountSummaries(ids), new Map<string, { feeStatus: string }>()),
      this.safe('Tracking state', () => this.prisma.trackingStudentState.findMany({
        where: { studentId: { in: ids } },
        select: { studentId: true, locationStatus: true, recordedAt: true },
      }), []),
      this.safe('Tracking settings', () => this.transportConfig.staleAfterMinutes(), 30),
    ]);
    const todayOf = new Map<string, string>();
    for (const a of attendance) {
      const s = links.find((l) => l.student.id === a.studentId)?.student;
      // The register of the child's current section wins when a transfer left two rows for today.
      if (!todayOf.has(a.studentId) || s?.sectionId === a.sectionId) todayOf.set(a.studentId, a.status);
    }
    const stateOf = new Map(states.map((s) => [s.studentId, s]));
    const mayTrack = viewer === 'family' ? can(user, 'tracking.read_own_children') : can(user, ...TRACK_STAFF);
    const now = Date.now();

    return links.map(({ student: s, relationship, isPrimary }) => {
      const enabled = s.trackingStatus !== 'disabled';
      const state = stateOf.get(s.id);
      const recordedAt = enabled && state?.recordedAt ? state.recordedAt : null;
      const fresh = !!recordedAt && now - recordedAt.getTime() <= staleMinutes * 60_000;
      const trackingStatus = s.trackingStatus === 'disabled' ? 'disabled' : s.trackingStatus === 'paused' ? 'paused' : fresh ? 'active' : 'offline';
      const canViewTracking = mayTrack && enabled;
      const route = s.transport?.route ?? null;
      return {
        id: s.id,
        admissionNo: s.admissionNo,
        fullName: s.fullName,
        firstName: s.firstName,
        lastName: s.lastName,
        grade: s.section.class.name,
        section: s.section.name,
        sectionId: s.sectionId,
        classId: s.section.classId,
        campusId: s.campusId,
        campusName: s.campus.name,
        house: s.house,
        today: todayOf.get(s.id) ?? 'unmarked',
        attendance: s.attendancePct == null ? null : round1(s.attendancePct),
        average: s.averageScore == null ? null : Math.round(s.averageScore),
        trend: s.scoreTrend == null ? 0 : round1(s.scoreTrend),
        risk: s.risk,
        feeStatus: fees.get(s.id)?.feeStatus ?? 'No charges',
        busRoute: route ? [route.code, route.name].filter(Boolean).join(' · ') : null,
        photoUrl: s.photoUrl,
        status: s.status,
        trackingStatus,
        relationship,
        isPrimary,
        canViewTracking,
        locationStatus: canViewTracking && recordedAt ? state?.locationStatus ?? 'unknown' : null,
        locationRecordedAt: canViewTracking && recordedAt ? recordedAt.toISOString() : null,
      };
    });
  }

  /** GET /parents/me — the signed-in parent and their children at the school (children who left are not listed). */
  async me(user: AuthUser) {
    if (!user.parentId) {
      // Staff and administrators hold no family record: the portal reports that no child is linked.
      const u = await this.prisma.user.findUnique({ where: { id: user.id }, select: { phone: true, email: true } });
      return { id: '', parentCode: '', fullName: user.fullName, phone: u?.phone ?? '', email: u?.email ?? user.email ?? null, children: [], formerChildren: [] };
    }
    const g = await this.prisma.guardian.findUnique({ where: { id: user.parentId } });
    if (!g) throw notFound('Parent record');
    let profile = await this.prisma.parentProfile.findUnique({ where: { guardianId: g.id }, select: { parentCode: true } });
    if (!profile) {
      await this.parents.ensureProfiles();
      profile = await this.prisma.parentProfile.findUnique({ where: { guardianId: g.id }, select: { parentCode: true } });
    }
    const all = await this.prisma.studentGuardian.findMany({
      where: { guardianId: g.id },
      select: { relationship: true, isPrimary: true, student: { select: CHILD_SELECT } },
    });
    all.sort((a, b) => a.student.firstName.localeCompare(b.student.firstName) || a.student.fullName.localeCompare(b.student.fullName));
    const links = all.filter((l) => l.student.status === 'active');
    const former = all.filter((l) => l.student.status !== 'active');
    return {
      id: g.id,
      parentCode: profile?.parentCode ?? '',
      fullName: g.fullName,
      phone: g.phone,
      email: g.email,
      children: await this.childRows(user, 'family', links),
      // Children who have left (discontinued, graduated, transferred): not active in the portal, but their fees,
      // receipts and records stay readable through the child routes.
      formerChildren: former.map(({ student: s, relationship }) => ({
        id: s.id, fullName: s.fullName, firstName: s.firstName, admissionNo: s.admissionNo, grade: s.section.class.name, section: s.section.name,
        campusName: s.campus.name, status: s.status, leftOn: ymd(s.discontinuedOn), relationship,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // A child's day
  // ---------------------------------------------------------------------------

  /** The child's bus today in the portal's shape (driver phone and fleet alerts stay with the transport office). */
  async bus(studentId: string) {
    const b = await this.transport.studentBus(studentId);
    if (!b) return null;
    return {
      routeId: b.routeId,
      routeCode: b.routeCode,
      routeName: b.routeName,
      area: b.area,
      runStatus: b.runStatus,
      delayMinutes: b.delayMinutes,
      eta: b.eta,
      busNo: b.busNo,
      registrationNo: b.registrationNo,
      driver: b.driver,
      attendant: b.attendant,
      stopName: b.stopName,
      pickupTime: b.pickupTime,
      dropTime: b.dropTime,
      mode: b.mode,
      busLocation: b.busLocation,
      boardingToday: b.boardingToday.map((e) => ({ type: e.type as 'boarded' | 'deboarded', at: e.at })),
    };
  }

  /** Homework of the child's section from the last 30 days and upcoming, with whether the child handed it in. */
  private async homework(student: { id: string; sectionId: string }, today: string) {
    const list = await this.prisma.homework.findMany({
      where: { sectionId: student.sectionId, status: { in: ['Open', 'Closed'] }, dueOn: { gte: dayValue(addDays(today, -30)) } },
      orderBy: [{ dueOn: 'asc' }, { createdAt: 'asc' }],
      take: 40,
      select: { id: true, title: true, status: true, dueOn: true, subjectId: true, submissions: { where: { studentId: student.id }, select: { status: true } } },
    });
    const subjectIds = [...new Set(list.map((h) => h.subjectId))];
    const subjects = subjectIds.length ? await this.prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }) : [];
    const name = new Map(subjects.map((s) => [s.id, s.name]));
    return list.map((h) => {
      const due = ymd(h.dueOn)!;
      return {
        id: h.id,
        subject: name.get(h.subjectId) ?? 'Subject',
        title: h.title,
        dueOn: due,
        status: homeworkStatus(h.status, due, today),
        submitted: h.submissions.length > 0,
      };
    });
  }

  /** The signed-in user's latest in-app notifications (the parent's own inbox; not shown to staff). */
  private async notifications(userId: string) {
    const rows = await this.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 8 });
    return rows.map((n) => ({
      id: n.id,
      category: n.category,
      tone: TONE[n.category as Category] ?? 'info',
      icon: n.icon ?? 'bell',
      title: n.title,
      body: n.body,
      route: n.route,
      createdAt: n.createdAt.toISOString(),
    }));
  }

  /** GET /parents/:pid/children/:cid/overview */
  async overview(user: AuthUser, child: ChildAccess) {
    const student = await this.prisma.student.findUnique({ where: { id: child.studentId }, select: CHILD_SELECT });
    if (!student) throw notFound('Student');
    const clock = await this.transportConfig.clock();
    const emptyFees = { billed: 0, paid: 0, outstanding: 0, nextDue: null as string | null };
    const [rows, gateToday, bus, homework, fees, notifications, events, pickup] = await Promise.all([
      this.childRows(user, child.viewer, [{ student, relationship: child.relationship ?? '', isPrimary: child.isPrimary }]),
      this.safe('Gate events', () => this.gate.todayFor(student.id), []),
      this.safe('Bus', () => this.bus(student.id), null),
      this.safe('Homework', () => this.homework(student, clock.today), []),
      this.safe('Fees', async () => {
        const f = (await this.ledger.accountSummaries([student.id])).get(student.id);
        return f ? { billed: f.billed, paid: f.paid, outstanding: f.balance, nextDue: f.nextDue } : emptyFees;
      }, emptyFees),
      child.viewer === 'family' ? this.safe('Notifications', () => this.notifications(user.id), []) : Promise.resolve([]),
      child.viewer === 'family'
        ? this.safe('Events', async () => (await this.events.familyEvents(user))
          .filter((e) => (e.endsOn ?? e.startsOn) >= clock.today)
          .slice(0, 10)
          .map((e) => ({ id: e.id, title: e.title, startsOn: e.startsOn, endsOn: e.endsOn, venue: e.venue, audience: e.audience })), [])
        : Promise.resolve([]),
      this.safe('Pickup', () => this.pickup.listForStudent(student.id), []),
    ]);
    return { child: rows[0], gateToday, bus, homework, fees, notifications, events, pickup };
  }

  // ---------------------------------------------------------------------------
  // Fees and receipts
  // ---------------------------------------------------------------------------

  /** GET /family/children/:id/fees — this year's account, every charge and the receipts. */
  async fees(studentId: string) {
    const [account, year] = await Promise.all([this.ledger.account(studentId), this.ledger.year()]);
    const payments = await this.prisma.financePayment.findMany({
      where: { studentId, status: { in: RECEIPT_STATUSES }, ...this.ledger.paymentYearWhere(year) },
      orderBy: { paidAt: 'desc' },
      select: { id: true, receiptNo: true, gatewayOrderId: true, amount: true, instrument: true, paidAt: true, status: true },
    });
    const s = account.summary;
    return {
      summary: {
        billed: Math.round((s.billed - s.concession) * 100) / 100,
        paid: s.paid,
        outstanding: s.outstanding,
        overdue: s.overdue,
        nextDue: s.nextDue,
        nextDueAmount: s.nextDueAmount,
      },
      lines: account.lines.map((l) => ({
        id: l.id, description: l.description, head: l.head, amountDue: l.amountDue, concession: l.concession, amountPaid: l.amountPaid,
        balance: l.balance, dueDate: l.dueDate, status: l.status,
      })),
      payments: payments.map((p) => ({
        id: p.id, receiptNo: p.receiptNo ?? p.gatewayOrderId ?? '—', amount: Number(p.amount), method: p.instrument, paidAt: p.paidAt.toISOString(), status: p.status,
      })),
    };
  }

  /** GET /family/receipts/:id — a printable receipt (the caller has checked the child). */
  async receipt(paymentId: string) {
    const r = await this.ledger.receipt(paymentId);
    if (!RECEIPT_STATUSES.includes(r.status)) throw notFound('Receipt');
    return {
      id: r.id,
      receiptNo: r.receiptNo,
      amount: r.amount,
      method: r.method,
      gatewayRef: r.gatewayRef,
      status: r.status,
      paidAt: r.paidAt,
      paidBy: r.paidBy,
      academicYear: r.academicYear,
      student: { fullName: r.student.fullName, admissionNo: r.student.admissionNo, grade: r.student.grade, section: r.student.section, campus: r.student.campus },
      lines: r.lines.map((l) => ({ feeId: l.feeId, description: l.description, head: l.head, amount: l.amount })),
    };
  }

  // ---------------------------------------------------------------------------
  // Safety
  // ---------------------------------------------------------------------------

  /** GET /family/children/:id/safety — gate scans today, the bus (with its live position) and authorised pickup persons. */
  async safety(studentId: string) {
    const [gateToday, bus, pickup] = await Promise.all([
      this.safe('Gate events', () => this.gate.todayFor(studentId), []),
      this.safe('Bus', () => this.bus(studentId), null),
      this.safe('Pickup', () => this.pickup.listForStudent(studentId), []),
    ]);
    return { gateToday, bus, pickup };
  }

  /** The pickup row as the portal lists it, for a person just added. */
  pickupRow(a: { id: string; personName: string; relation: string; method: string; status: string; lastPickupAt: Date | null }) {
    return { id: a.id, personName: a.personName, relation: a.relation, method: a.method, status: a.status, lastPickupAt: iso(a.lastPickupAt) };
  }
}
