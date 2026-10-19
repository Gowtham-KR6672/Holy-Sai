import { Injectable } from '@nestjs/common';
import type { SafetyPickupAuthorisation, SafetyPickupEvent } from '@prisma/client';
import { createHash, randomInt } from 'node:crypto';
import type { Request } from 'express';
import { env } from '../../config/env';
import type { AuthUser } from '../../common/auth-user';
import { badRequest, conflict, fieldError, forbidden, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MessagingService } from '../integrations/messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GateEventsService } from './gate.service';
import { IncidentsService } from './incidents.service';
import { GATES, iso, PICKUP_METHODS, SafetyContext, type StudentInfo } from './safety.util';

export const PHONE_RE = /^\+?[0-9 ]{8,16}$/;
export const PICKUP_ENTITY = 'pickup_authorisation';
const OTP_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const PARENT_ROUTE = '/parent-360?tab=safety';

export interface AddPickupInput {
  studentId: string;
  personName: string;
  relation: string;
  phone?: string | null;
  method?: string;
}

/** Gate scan method recorded when a child is released after this kind of verification. */
const gateMethodFor = (method: string) => (method.startsWith('QR') ? 'QR' : method === 'Face' ? 'Face' : 'Manual');

/**
 * Pickup authorisation: who may collect each child, OTP verification through the registered parents,
 * releases, revocations and held (unauthorised) collections. Used by the office pages and the family portal.
 */
@Injectable()
export class PickupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: SafetyContext,
    private readonly notifications: NotificationsService,
    private readonly messaging: MessagingService,
    private readonly audit: AuditService,
    private readonly gate: GateEventsService,
    private readonly incidents: IncidentsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Shapes
  // ---------------------------------------------------------------------------
  async rows(list: SafetyPickupAuthorisation[]) {
    const [students, users] = await Promise.all([
      this.ctx.students(list.map((a) => a.studentId)),
      this.ctx.userNames(list.map((a) => a.approvedById)),
    ]);
    const now = Date.now();
    return list.map((a) => {
      const s = students.get(a.studentId);
      return {
        id: a.id,
        studentId: a.studentId,
        studentName: s?.fullName ?? 'Unknown student',
        admissionNo: s?.admissionNo ?? '',
        grade: s?.grade ?? null,
        section: s?.section ?? null,
        personName: a.personName,
        relation: a.relation,
        phone: a.phone,
        method: a.method,
        status: a.status as 'Pending' | 'Verified' | 'Revoked',
        lastPickupAt: iso(a.lastPickupAt),
        createdAt: a.createdAt.toISOString(),
        parentApproved: a.parentApproved,
        approvedByName: a.approvedById ? (users.get(a.approvedById) ?? null) : null,
        otpExpiresAt: a.status === 'Pending' && a.otpExpiresAt && a.otpExpiresAt.getTime() > now ? a.otpExpiresAt.toISOString() : null,
      };
    });
  }

  async eventRows(list: (SafetyPickupEvent & { incident?: { code: string } | null })[]) {
    const students = await this.ctx.students(list.map((e) => e.studentId));
    return list.map((e) => ({
      id: e.id,
      occurredAt: e.occurredAt.toISOString(),
      outcome: e.outcome as 'collected' | 'held',
      personName: e.personName,
      gate: e.gate,
      method: e.method,
      notes: e.notes,
      studentId: e.studentId,
      studentName: students.get(e.studentId)?.fullName ?? 'Unknown student',
      incidentCode: e.incident?.code ?? null,
      resolved: e.resolved,
    }));
  }

  /** Authorised persons for one child (family portal), without revoked ones. */
  async listForStudent(studentId: string) {
    const rows = await this.prisma.safetyPickupAuthorisation.findMany({
      where: { studentId, status: { not: 'Revoked' } },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((a) => ({
      id: a.id,
      personName: a.personName,
      relation: a.relation,
      method: a.method,
      status: a.status,
      lastPickupAt: iso(a.lastPickupAt),
    }));
  }

  private async load(user: AuthUser, id: string): Promise<{ auth: SafetyPickupAuthorisation; student: StudentInfo }> {
    const auth = await this.prisma.safetyPickupAuthorisation.findUnique({ where: { id } });
    if (!auth) throw notFound('Authorised person');
    const student = await this.ctx.assertStudent(user, auth.studentId);
    return { auth, student };
  }

  private gateName(gate: string | undefined, gates: string[]): string {
    const all = [...new Set([...gates, ...GATES])];
    const g = all.find((x) => x.toLowerCase() === (gate ?? '').trim().toLowerCase());
    if (!g) throw fieldError('gate', 'Choose a gate');
    return g;
  }

  // ---------------------------------------------------------------------------
  // Adding, verifying, revoking
  // ---------------------------------------------------------------------------
  /** Adds an authorised person. Office additions ask the parents to confirm; parent additions go to the office to verify. */
  async add(user: AuthUser, input: AddPickupInput, via: 'office' | 'parent', req?: Request) {
    const student = await this.ctx.assertStudent(user, input.studentId);
    const personName = input.personName.trim();
    const relation = input.relation.trim();
    const phone = input.phone?.trim() || null;
    const method = input.method ?? 'OTP + ID';
    if (personName.length < 2) throw fieldError('personName', 'Enter the full name');
    if (relation.length < 2) throw fieldError('relation', 'Enter the relationship');
    if (!PICKUP_METHODS.includes(method)) throw fieldError('method', 'Choose a verification method');
    if (phone && !PHONE_RE.test(phone)) throw fieldError('phone', 'Enter a valid phone number');
    if (/OTP/.test(method) && !phone) throw fieldError('phone', 'A phone number is needed for OTP verification');

    const existing = await this.prisma.safetyPickupAuthorisation.findFirst({
      where: { studentId: student.id, status: { not: 'Revoked' }, personName: { equals: personName, mode: 'insensitive' } },
    });
    if (existing) throw fieldError('personName', `${personName} is already on ${student.firstName}'s list`);

    const now = new Date();
    const auth = await this.prisma.safetyPickupAuthorisation.create({
      data: {
        campusId: student.campusId,
        studentId: student.id,
        personName,
        relation,
        phone,
        method,
        status: 'Pending',
        addedVia: via,
        addedById: user.id,
        parentApproved: via === 'parent',
        approvedById: via === 'parent' ? user.id : null,
        approvedAt: via === 'parent' ? now : null,
      },
    });

    if (via === 'office') {
      await this.notifications.notifyGuardians(student.id, {
        category: 'Attention',
        topic: 'safety',
        module: 'safety',
        title: `New pickup person for ${student.firstName}`,
        body: `The school added ${personName} (${relation}) as someone who may collect ${student.firstName}. Confirm or revoke in the app.`,
        route: PARENT_ROUTE,
        campusId: student.campusId,
        deliver: true,
      });
    } else {
      await this.notifications.createTaskForPermission('safety.manage', {
        title: `Verify pickup person ${personName} (${relation}) for ${student.fullName}`,
        module: 'safety',
        priority: 'Medium',
        status: 'Under Review',
        route: `/pickup?studentId=${student.id}`,
        entityType: PICKUP_ENTITY,
        entityId: auth.id,
      }, student.campusId);
    }
    await this.audit.record({
      user, action: 'create', module: 'safety', entityType: PICKUP_ENTITY, entityId: auth.id, campusId: student.campusId, req,
      description: `${via === 'parent' ? 'Parent added' : 'Added'} ${personName} (${relation}, ${method}) as an authorised pickup person for ${student.fullName}`,
    });
    return auth;
  }

  /** Sends a 6-digit code (valid 10 minutes) to the child's registered parents. */
  async sendOtp(user: AuthUser, id: string, req?: Request): Promise<{ expiresAt: string; sentTo: number; devCode?: string }> {
    const { auth, student } = await this.load(user, id);
    if (auth.status === 'Revoked') throw badRequest('This authorisation was revoked');
    if (auth.status === 'Verified') throw badRequest(`${auth.personName} is already verified`);
    if (auth.otpSentAt && Date.now() - auth.otpSentAt.getTime() < 30_000) throw conflict('A code was sent a moment ago. Wait 30 seconds before sending another.');

    const links = await this.prisma.studentGuardian.findMany({ where: { studentId: student.id }, include: { guardian: { select: { id: true, phone: true } } } });
    if (!links.length) throw badRequest(`No parent or guardian is registered for ${student.fullName}. Add one before sending a code.`);
    const parentUsers = await this.prisma.user.findMany({
      where: { parentId: { in: links.map((l) => l.guardianId) }, status: 'active' },
      select: { id: true, parentId: true },
    });

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + OTP_MINUTES * 60_000);
    await this.prisma.safetyPickupAuthorisation.update({
      where: { id },
      data: { otpHash: this.hash(id, code), otpSentAt: now, otpExpiresAt: expiresAt, otpAttempts: 0 },
    });

    const text = `Holy Sai: ${code} is the code for ${auth.personName} (${auth.relation}) to collect ${student.firstName}. Share it only if you sent them. Valid for ${OTP_MINUTES} minutes.`;
    const reached = new Set<string>();
    let delivered = 0;
    const phones = new Map<string, string>();
    for (const l of links) if (l.guardian.phone?.trim()) phones.set(l.guardian.phone.replace(/\s/g, ''), l.guardianId);
    for (const [phone, guardianId] of phones) {
      const link = { entityType: PICKUP_ENTITY, entityId: id };
      let r = await this.messaging.send('sms', { to: phone, body: text }, link);
      if (!r.ok) r = await this.messaging.send('whatsapp', { to: phone, body: text }, link);
      if (r.ok) {
        delivered++;
        reached.add(guardianId);
      }
    }
    if (parentUsers.length) {
      await this.notifications.notifyUsers(parentUsers.map((u) => u.id), {
        category: 'Attention',
        topic: 'safety',
        module: 'safety',
        title: `Pickup code for ${student.firstName}`,
        body: text,
        route: PARENT_ROUTE,
        campusId: student.campusId,
      });
      for (const u of parentUsers) if (u.parentId) reached.add(u.parentId);
    }

    await this.audit.record({
      user, action: 'update', module: 'safety', entityType: PICKUP_ENTITY, entityId: id, campusId: student.campusId, req,
      description: `Sent a pickup verification code for ${auth.personName} to ${reached.size} parent contact(s) of ${student.fullName}`,
    });
    const result: { expiresAt: string; sentTo: number; devCode?: string } = { expiresAt: expiresAt.toISOString(), sentTo: reached.size };
    if (!delivered && !env().isProduction) result.devCode = code;
    return result;
  }

  /** Checks the code read out at the gate and marks the person Verified. */
  async verifyOtp(user: AuthUser, id: string, code: string, req?: Request) {
    const { auth, student } = await this.load(user, id);
    if (auth.status === 'Revoked') throw badRequest('This authorisation was revoked');
    if (auth.status === 'Verified') throw badRequest(`${auth.personName} is already verified`);
    if (!auth.otpHash || !auth.otpExpiresAt) throw fieldError('code', 'Send a code to the parent first');
    if (auth.otpExpiresAt.getTime() < Date.now()) throw fieldError('code', 'The code has expired. Send a new one.');
    if (auth.otpAttempts >= OTP_MAX_ATTEMPTS) throw fieldError('code', 'Too many attempts. Send a new code.');
    if (this.hash(id, code.trim()) !== auth.otpHash) {
      const attempts = auth.otpAttempts + 1;
      await this.prisma.safetyPickupAuthorisation.update({ where: { id }, data: { otpAttempts: attempts } });
      throw fieldError('code', attempts >= OTP_MAX_ATTEMPTS ? 'That code is not correct. Too many attempts — send a new code.' : 'That code is not correct');
    }
    const now = new Date();
    const updated = await this.prisma.safetyPickupAuthorisation.update({
      where: { id },
      data: { status: 'Verified', verifiedVia: 'otp', verifiedAt: now, approvedById: user.id, approvedAt: now, otpHash: null, otpExpiresAt: null, otpAttempts: 0 },
    });
    await this.notifications.completeTasksFor(PICKUP_ENTITY, id);
    await this.notifications.notifyGuardians(student.id, {
      category: 'Information',
      topic: 'safety',
      module: 'safety',
      title: `${auth.personName} verified for pickup`,
      body: `${auth.personName} (${auth.relation}) is now verified to collect ${student.firstName}.`,
      route: PARENT_ROUTE,
      campusId: student.campusId,
    });
    await this.audit.record({
      user, action: 'approve', module: 'safety', entityType: PICKUP_ENTITY, entityId: id, campusId: student.campusId, req,
      description: `Verified ${auth.personName} by OTP to collect ${student.fullName}`,
    });
    return updated;
  }

  /** Releases the child to a verified person: records the collection, the gate exit, and tells the parents. */
  async collect(user: AuthUser, id: string, dto: { gate: string; notes?: string }, req?: Request) {
    const { auth, student } = await this.load(user, id);
    if (auth.status === 'Revoked') throw badRequest(`${auth.personName} is no longer authorised`);
    if (auth.status !== 'Verified') throw badRequest(`Verify ${auth.personName} before releasing ${student.firstName}`);
    const { gates } = await this.ctx.gates();
    const gate = this.gateName(dto.gate, gates);
    const clock = await this.ctx.clock();
    const now = new Date();
    const today = clock.today();
    const day = clock.dayValue(today);

    const event = await this.prisma.safetyPickupEvent.create({
      data: {
        campusId: student.campusId,
        studentId: student.id,
        authorisationId: auth.id,
        outcome: 'collected',
        personName: auth.personName,
        gate,
        method: auth.method,
        notes: dto.notes?.trim() || null,
        resolved: true,
        occurredAt: now,
        day,
        recordedById: user.id,
      },
    });
    await this.prisma.safetyPickupAuthorisation.update({ where: { id }, data: { lastPickupAt: now } });
    // A held collection earlier today is resolved once a verified person collects the child.
    await this.prisma.safetyPickupEvent.updateMany({ where: { studentId: student.id, day, outcome: 'held', resolved: false }, data: { resolved: true, resolvedAt: now } });
    // A child waiting in the sick bay has now gone home.
    const { start, end } = clock.bounds(today);
    await this.prisma.safetyInfirmaryVisit.updateMany({ where: { studentId: student.id, outcome: 'Awaiting pickup', visitedAt: { gte: start, lt: end } }, data: { outcome: 'Sent home' } });
    await this.gate.record({ studentId: student.id, direction: 'out', gate, method: gateMethodFor(auth.method), source: 'pickup', recordedById: user.id, notify: false }, student);

    await this.notifications.notifyGuardians(student.id, {
      category: 'Information',
      topic: 'safety',
      module: 'safety',
      title: `${student.firstName} was collected`,
      body: `Released to ${auth.personName} (${auth.relation}) at the ${gate} at ${clock.time(now)}.`,
      route: PARENT_ROUTE,
      campusId: student.campusId,
      deliver: true,
    });
    await this.audit.record({
      user, action: 'create', module: 'safety', entityType: 'pickup_event', entityId: event.id, campusId: student.campusId, req,
      description: `Released ${student.fullName} to ${auth.personName} (${auth.relation}) at the ${gate}`,
    });
    return { event, student, auth };
  }

  /** Revokes a person. The parents are informed. */
  async revoke(user: AuthUser, id: string, req?: Request, by: 'office' | 'parent' = 'office') {
    const { auth, student } = await this.load(user, id);
    if (auth.status === 'Revoked') throw badRequest(`${auth.personName} is already revoked`);
    const updated = await this.prisma.safetyPickupAuthorisation.update({
      where: { id },
      data: { status: 'Revoked', revokedAt: new Date(), revokedById: user.id, otpHash: null, otpExpiresAt: null },
    });
    await this.notifications.completeTasksFor(PICKUP_ENTITY, id);
    await this.notifications.notifyGuardians(student.id, {
      category: 'Attention',
      topic: 'safety',
      module: 'safety',
      title: `Pickup authorisation revoked for ${auth.personName}`,
      body: `${auth.personName} (${auth.relation}) may no longer collect ${student.firstName}${by === 'parent' ? '' : ' (revoked by the school office)'}.`,
      route: PARENT_ROUTE,
      campusId: student.campusId,
      deliver: by === 'office',
    });
    await this.audit.record({
      user, action: 'update', module: 'safety', entityType: PICKUP_ENTITY, entityId: id, campusId: student.campusId, req,
      description: `${by === 'parent' ? 'Parent revoked' : 'Revoked'} ${auth.personName} as a pickup person for ${student.fullName}`,
    });
    return updated;
  }

  /**
   * An unauthorised person asked to collect a child: the collection is held, a Critical security incident is
   * logged, and the front office, the Principal and the parents are alerted.
   */
  async hold(user: AuthUser, dto: { studentId: string; personName: string; gate: string; notes?: string }, req?: Request) {
    const student = await this.ctx.assertStudent(user, dto.studentId);
    const { gates } = await this.ctx.gates();
    const gate = this.gateName(dto.gate, gates);
    const personName = dto.personName.trim();
    if (personName.length < 2) throw fieldError('personName', 'Enter the name the person gave');
    const clock = await this.ctx.clock();
    const now = new Date();
    const today = clock.today();

    const incident = await this.incidents.create(user, {
      campusId: student.campusId,
      incidentType: 'Security',
      summary: `Unauthorised pickup attempt for ${student.fullName}`.slice(0, 200),
      details: [`${personName} asked to collect ${student.fullName} (${student.admissionNo}) at the ${gate} at ${clock.time(now)} and is not on the authorised list. Collection held.`, dto.notes?.trim()].filter(Boolean).join('\n\n'),
      severity: 'Critical',
      occurredOn: today,
      studentId: student.id,
      ownerId: user.employeeId ?? null,
      source: 'pickup',
    }, req);
    const event = await this.prisma.safetyPickupEvent.create({
      data: {
        campusId: student.campusId,
        studentId: student.id,
        outcome: 'held',
        personName,
        gate,
        notes: dto.notes?.trim() || null,
        incidentId: incident.id,
        resolved: false,
        occurredAt: now,
        day: clock.dayValue(today),
        recordedById: user.id,
      },
    });
    await this.notifications.notifyPermission('safety.manage', {
      category: 'Critical',
      topic: 'safety',
      module: 'safety',
      title: `Collection held: ${student.fullName}`,
      body: `${personName} asked to collect ${student.firstName} at the ${gate} and is not authorised. ${incident.code} logged — keep the child with staff.`,
      route: '/pickup',
      campusId: student.campusId,
      deliver: true,
    });
    await this.notifications.notifyGuardians(student.id, {
      category: 'Critical',
      topic: 'safety',
      module: 'safety',
      title: `Collection of ${student.firstName} held`,
      body: `${personName} asked to collect ${student.firstName} at the ${gate} at ${clock.time(now)} and is not on your authorised list. ${student.firstName} is safe with staff. Please call the school office.`,
      route: PARENT_ROUTE,
      campusId: student.campusId,
      deliver: true,
    });
    await this.audit.record({
      user, action: 'create', module: 'safety', entityType: 'pickup_event', entityId: event.id, campusId: student.campusId, req,
      description: `Held the collection of ${student.fullName}: ${personName} is not authorised (${incident.code})`,
    });
    return { incident, event };
  }

  // ---------------------------------------------------------------------------
  // Family portal
  // ---------------------------------------------------------------------------
  /** A parent adds someone; the school office verifies them before the first pickup. */
  addByParent(user: AuthUser, studentId: string, dto: Omit<AddPickupInput, 'studentId'>, req?: Request) {
    return this.add(user, { ...dto, studentId, method: dto.method && PICKUP_METHODS.includes(dto.method) ? dto.method : 'OTP + ID' }, 'parent', req);
  }

  /** A parent confirms a person the school added (counts as verification). */
  async confirmByParent(user: AuthUser, studentId: string, id: string, req?: Request) {
    const { auth, student } = await this.load(user, id);
    if (auth.studentId !== studentId) throw forbidden('This person is not on your child’s list');
    if (auth.status === 'Revoked') throw badRequest('This authorisation was revoked');
    if (auth.status === 'Verified') return auth;
    if (auth.addedVia === 'parent') throw badRequest('The school office verifies the people you add before their first pickup');
    const now = new Date();
    const updated = await this.prisma.safetyPickupAuthorisation.update({
      where: { id },
      data: { status: 'Verified', parentApproved: true, verifiedVia: 'parent', verifiedAt: now, approvedById: user.id, approvedAt: now, otpHash: null, otpExpiresAt: null },
    });
    await this.notifications.completeTasksFor(PICKUP_ENTITY, id);
    await this.audit.record({
      user, action: 'approve', module: 'safety', entityType: PICKUP_ENTITY, entityId: id, campusId: student.campusId, req,
      description: `Parent confirmed ${auth.personName} as a pickup person for ${student.fullName}`,
    });
    return updated;
  }

  async revokeByParent(user: AuthUser, studentId: string, id: string, req?: Request) {
    const auth = await this.prisma.safetyPickupAuthorisation.findUnique({ where: { id }, select: { studentId: true } });
    if (!auth) throw notFound('Authorised person');
    if (auth.studentId !== studentId) throw forbidden('This person is not on your child’s list');
    return this.revoke(user, id, req, 'parent');
  }

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------
  async summary(user: AuthUser, campusId?: string) {
    const clock = await this.ctx.clock();
    const today = clock.today();
    const { start, end } = clock.bounds(today);
    const recordWhere = await this.ctx.recordWhere(user, campusId);
    const [active, otpToday, events] = await Promise.all([
      this.prisma.safetyPickupAuthorisation.findMany({ where: { ...recordWhere, status: { not: 'Revoked' } }, select: { studentId: true, status: true, method: true } }),
      this.prisma.safetyPickupAuthorisation.count({ where: { ...recordWhere, verifiedVia: 'otp', verifiedAt: { gte: start, lt: end } } }),
      this.prisma.safetyPickupEvent.findMany({ where: { ...recordWhere, day: clock.dayValue(today) }, orderBy: { occurredAt: 'desc' }, include: { incident: { select: { code: true } } } }),
    ]);
    const students = new Set(active.map((a) => a.studentId)).size;
    const verified = active.filter((a) => a.status === 'Verified');
    const held = events.filter((e) => e.outcome === 'held');
    return {
      authorisedPersons: active.length,
      studentsCovered: students,
      averagePerStudent: students ? Math.round((active.length / students) * 10) / 10 : 0,
      verifiedByQrPct: verified.length ? Math.round((verified.filter((a) => a.method.includes('QR')).length / verified.length) * 100) : 0,
      pendingConfirmation: active.filter((a) => a.status === 'Pending').length,
      otpVerificationsToday: otpToday,
      collectedToday: events.filter((e) => e.outcome === 'collected').length,
      heldToday: held.length,
      heldResolved: held.filter((e) => e.resolved).length,
      recentEvents: await this.eventRows(events.slice(0, 20)),
    };
  }

  private hash(id: string, code: string) {
    return createHash('sha256').update(`${id}:${code}`).digest('hex');
  }
}
