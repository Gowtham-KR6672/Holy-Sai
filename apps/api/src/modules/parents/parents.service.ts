import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { paged } from '../../common/envelope';
import { fieldError, forbidden, notFound } from '../../common/errors';
import { like, pageOf, sortBy } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import type { DirectoryQuery, ParentDto } from './dto';
import { addDays, clampScore, dateOnly, daysAgo, ENGAGEMENT, iso, todayKey } from './parents.util';

type GuardianWithChildren = Prisma.GuardianGetPayload<{
  include: { students: { include: { student: { include: { section: { include: { class: true } } } } } } };
}>;

const CHILDREN = { students: { include: { student: { include: { section: { include: { class: true } } } } } } } as const;

/** Resolves fee status for students; registered by the finance module when it is available. */
export type FeeStatusResolver = (studentIds: string[]) => Promise<Map<string, string>>;

/**
 * Parent records (core Guardian rows) as the directory shows them, plus the shared family helpers:
 * scope, app accounts, PTM booking state and engagement/last-contact updates.
 */
@Injectable()
export class ParentsService {
  private feeResolvers: FeeStatusResolver[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  /** Lets the finance module supply each child's fee status (Paid / Due / Overdue …). */
  registerFeeStatus(fn: FeeStatusResolver) {
    this.feeResolvers.push(fn);
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /** Gives every guardian (including those created by admissions) a parent code such as PAR-1001. */
  async ensureProfiles(): Promise<void> {
    const missing = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT g."id"::text AS id FROM "Guardian" g
      LEFT JOIN "ParentProfile" p ON p."guardianId" = g."id"
      WHERE p."guardianId" IS NULL
      ORDER BY g."createdAt" ASC
      LIMIT 5000`;
    if (!missing.length) return;
    const n = missing.length;
    const c = await this.prisma.counter.upsert({
      where: { key: 'parent-code' },
      create: { key: 'parent-code', value: 1000 + n },
      update: { value: { increment: n } },
    });
    const first = c.value - n + 1;
    await this.prisma.parentProfile.createMany({
      data: missing.map((m, i) => ({ guardianId: m.id, parentCode: `PAR-${first + i}` })),
      skipDuplicates: true,
    });
  }

  /** Guardians the user may see. School scope on a campus also lists parents with no child linked yet. */
  async guardianWhere(user: AuthUser, requestedCampus?: string | null): Promise<Prisma.GuardianWhereInput> {
    const sw = await this.scope.studentWhere(user, requestedCampus);
    if (!Object.keys(sw).length) return {};
    if (user.scope === 'school') return { OR: [{ students: { some: { student: sw } } }, { students: { none: {} } }] };
    return { students: { some: { student: sw } } };
  }

  /** Guardian ids a non-school user is limited to (teachers: families of their sections); undefined = no limit. */
  async familyLimit(user: AuthUser): Promise<string[] | undefined> {
    if (user.scope === 'school') return undefined;
    const sw = await this.scope.studentWhere(user);
    const links = await this.prisma.studentGuardian.findMany({ where: { student: sw }, select: { guardianId: true } });
    return [...new Set(links.map((l) => l.guardianId))];
  }

  async assertGuardian(user: AuthUser, id: string) {
    const where = await this.guardianWhere(user);
    const n = await this.prisma.guardian.count({ where: { AND: [where, { id }] } });
    if (n) return;
    const exists = await this.prisma.guardian.count({ where: { id } });
    throw exists ? forbidden('This family is outside your access') : notFound('Parent');
  }

  /** Families with an active parent-app account. */
  async appSet(guardianIds?: string[]): Promise<Set<string>> {
    const users = await this.prisma.user.findMany({
      where: { status: 'active', parentId: guardianIds ? { in: guardianIds } : { not: null } },
      select: { parentId: true },
    });
    return new Set(users.map((u) => u.parentId!));
  }

  /** Families with a PTM booking (Booked or Attended) in a session from the last 30 days onwards. */
  async ptmBookedSet(guardianIds?: string[]): Promise<Set<string>> {
    const bookings = await this.prisma.ptmBooking.findMany({
      where: { status: { in: ['Booked', 'Attended'] }, session: { sessionDate: { gte: dateOnly(addDays(todayKey(), -30)) } } },
      select: { studentId: true, guardianId: true },
    });
    const set = new Set<string>();
    for (const b of bookings) if (b.guardianId) set.add(b.guardianId);
    // A booking for a child books every guardian of that child.
    const studentIds = [...new Set(bookings.map((b) => b.studentId))];
    if (studentIds.length) {
      const links = await this.prisma.studentGuardian.findMany({
        where: { studentId: { in: studentIds }, ...(guardianIds ? { guardianId: { in: guardianIds } } : {}) },
        select: { guardianId: true },
      });
      for (const l of links) set.add(l.guardianId);
    }
    if (!guardianIds) return set;
    const want = new Set(guardianIds);
    return new Set([...set].filter((id) => want.has(id)));
  }

  /** Messages from each family still awaiting a reply. */
  async openQueries(guardianIds: string[]): Promise<Map<string, number>> {
    if (!guardianIds.length) return new Map();
    const rows = await this.prisma.commMessage.groupBy({
      by: ['guardianId'],
      where: { guardianId: { in: guardianIds }, needsReply: true },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.guardianId!, r._count._all]));
  }

  /**
   * Records an interaction with a family: updates the last contact (when a channel is given) and moves the
   * engagement score (0–100) by `delta`. Used by messages, calls, acknowledgements and PTM bookings.
   */
  async touch(guardianId: string | null | undefined, opts: { channel?: string | null; delta?: number }) {
    if (!guardianId) return;
    const g = await this.prisma.guardian.findUnique({ where: { id: guardianId }, select: { engagementScore: true } });
    if (!g) return;
    const data: Prisma.GuardianUpdateInput = {};
    if (opts.delta) data.engagementScore = clampScore(g.engagementScore + opts.delta);
    if (opts.channel) {
      data.lastInteractionAt = new Date();
      data.lastInteractionChannel = opts.channel;
    }
    if (Object.keys(data).length) await this.prisma.guardian.update({ where: { id: guardianId }, data });
  }

  /** Engagement change for every guardian of a student (e.g. PTM attendance). */
  async touchFamilyOf(studentId: string, opts: { channel?: string | null; delta?: number }) {
    const links = await this.prisma.studentGuardian.findMany({ where: { studentId }, select: { guardianId: true } });
    for (const l of links) await this.touch(l.guardianId, opts);
  }

  /** The campus a family belongs to: the given child's, else the first active child's. */
  async campusOf(guardianId: string | null | undefined, studentId?: string | null): Promise<string | null> {
    if (studentId) {
      const s = await this.prisma.student.findUnique({ where: { id: studentId }, select: { campusId: true } });
      if (s) return s.campusId;
    }
    if (!guardianId) return null;
    const link = await this.prisma.studentGuardian.findFirst({
      where: { guardianId },
      orderBy: [{ isPrimary: 'desc' }],
      select: { student: { select: { campusId: true } } },
    });
    return link?.student.campusId ?? null;
  }

  // ---------------------------------------------------------------------------
  // Directory
  // ---------------------------------------------------------------------------
  async directory(user: AuthUser, q: DirectoryQuery) {
    await this.ensureProfiles();
    const p = pageOf(q);
    const AND: Prisma.GuardianWhereInput[] = [];
    const sw = await this.scope.studentWhere(user, q.campusId);
    if (q.gradeLevel != null && Number.isFinite(q.gradeLevel)) {
      AND.push({ students: { some: { student: { AND: [sw, { status: 'active', section: { class: { gradeLevel: q.gradeLevel } } }] } } } });
    } else if (Object.keys(sw).length) {
      AND.push(user.scope === 'school' ? { OR: [{ students: { some: { student: sw } } }, { students: { none: {} } }] } : { students: { some: { student: sw } } });
    }
    if (q.q?.trim()) {
      const term = q.q.trim();
      const prof = await this.prisma.parentProfile.findMany({
        where: { OR: [{ parentCode: like(term) }, { altPhone: like(term) }] },
        select: { guardianId: true },
        take: 500,
      });
      AND.push({ OR: [{ fullName: like(term) }, { phone: like(term) }, { email: like(term) }, { id: { in: prof.map((x) => x.guardianId) } }] });
    }
    if (q.engagement === 'high') AND.push({ engagementScore: { gte: ENGAGEMENT.high } });
    if (q.engagement === 'medium') AND.push({ engagementScore: { gte: ENGAGEMENT.medium, lt: ENGAGEMENT.high } });
    if (q.engagement === 'low') AND.push({ engagementScore: { lt: ENGAGEMENT.medium } });
    if (q.app) {
      const set = [...(await this.appSet())];
      AND.push(q.app === 'yes' ? { id: { in: set } } : { id: { notIn: set } });
    }
    if (q.ptm) {
      const set = [...(await this.ptmBookedSet())];
      AND.push(q.ptm === 'booked' ? { id: { in: set } } : { id: { notIn: set } });
    }
    const where: Prisma.GuardianWhereInput = { AND };
    const orderBy = sortBy<Prisma.GuardianOrderByWithRelationInput[]>(q.sort, q.dir, {
      name: (d) => [{ fullName: d }],
      engagement: (d) => [{ engagementScore: d }, { fullName: 'asc' }],
      lastContact: (d) => [{ lastInteractionAt: { sort: d, nulls: d === 'asc' ? 'first' : 'last' } }, { fullName: 'asc' }],
    }, 'name');
    const [rows, total] = await Promise.all([
      this.prisma.guardian.findMany({ where, orderBy, skip: p.skip, take: p.take, include: CHILDREN }),
      this.prisma.guardian.count({ where }),
    ]);
    return paged(await this.directoryRows(rows), total, p);
  }

  async directoryRows(rows: GuardianWithChildren[]) {
    const ids = rows.map((r) => r.id);
    const [profiles, app, booked, open] = await Promise.all([
      this.prisma.parentProfile.findMany({ where: { guardianId: { in: ids } } }),
      this.appSet(ids),
      this.ptmBookedSet(ids),
      this.openQueries(ids),
    ]);
    const code = new Map(profiles.map((x) => [x.guardianId, x.parentCode]));
    return rows.map((g) => ({
      id: g.id,
      parentCode: code.get(g.id) ?? '',
      fullName: g.fullName,
      phone: g.phone,
      email: g.email,
      occupation: g.occupation,
      preferredChannel: g.preferredChannel,
      engagement: g.engagementScore,
      lastContactAt: iso(g.lastInteractionAt),
      lastContactChannel: g.lastInteractionChannel,
      hasAppAccount: app.has(g.id),
      children: g.students
        .filter((l) => l.student.status === 'active')
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.student.fullName.localeCompare(b.student.fullName))
        .map((l) => ({ id: l.student.id, fullName: l.student.fullName, grade: l.student.section.class.name, section: l.student.section.name })),
      ptmBooked: booked.has(g.id),
      openQueries: open.get(g.id) ?? 0,
    }));
  }

  async summary(user: AuthUser, campusId?: string) {
    const base = await this.guardianWhere(user, campusId);
    const and = (w: Prisma.GuardianWhereInput): Prisma.GuardianWhereInput => ({ AND: [base, w] });
    const appIds = [...(await this.appSet())];
    const [parents, high, medium, low, avg, contacted7d, noContact30d, appAccounts] = await Promise.all([
      this.prisma.guardian.count({ where: base }),
      this.prisma.guardian.count({ where: and({ engagementScore: { gte: ENGAGEMENT.high } }) }),
      this.prisma.guardian.count({ where: and({ engagementScore: { gte: ENGAGEMENT.medium, lt: ENGAGEMENT.high } }) }),
      this.prisma.guardian.count({ where: and({ engagementScore: { lt: ENGAGEMENT.medium } }) }),
      this.prisma.guardian.aggregate({ where: base, _avg: { engagementScore: true } }),
      this.prisma.guardian.count({ where: and({ lastInteractionAt: { gte: daysAgo(7) } }) }),
      this.prisma.guardian.count({ where: and({ OR: [{ lastInteractionAt: null }, { lastInteractionAt: { lt: daysAgo(30) } }] }) }),
      this.prisma.guardian.count({ where: and({ id: { in: appIds } }) }),
    ]);
    return {
      parents,
      appAccounts,
      high,
      medium,
      low,
      averageEngagement: Math.round(avg._avg.engagementScore ?? 0),
      noContact30d,
      contacted7d,
    };
  }

  // ---------------------------------------------------------------------------
  // Parent record
  // ---------------------------------------------------------------------------
  async record(id: string) {
    const g = await this.prisma.guardian.findUnique({ where: { id } });
    if (!g) throw notFound('Parent');
    let profile = await this.prisma.parentProfile.findUnique({ where: { guardianId: id } });
    if (!profile) {
      await this.ensureProfiles();
      profile = await this.prisma.parentProfile.findUnique({ where: { guardianId: id } });
    }
    const app = await this.appSet([id]);
    return {
      id: g.id,
      parentCode: profile?.parentCode ?? '',
      fullName: g.fullName,
      phone: g.phone,
      altPhone: profile?.altPhone ?? null,
      email: g.email,
      occupation: g.occupation,
      address: g.address,
      preferredChannel: g.preferredChannel,
      language: g.language,
      engagement: g.engagementScore,
      lastContactAt: iso(g.lastInteractionAt),
      lastContactChannel: g.lastInteractionChannel,
      hasAppAccount: app.has(g.id),
      createdAt: g.createdAt.toISOString(),
    };
  }

  async children(id: string) {
    const links = await this.prisma.studentGuardian.findMany({
      where: { guardianId: id },
      include: { student: { include: { section: { include: { class: true } } } } },
    });
    links.sort(
      (a, b) =>
        Number(b.student.status === 'active') - Number(a.student.status === 'active') ||
        Number(b.isPrimary) - Number(a.isPrimary) ||
        a.student.fullName.localeCompare(b.student.fullName),
    );
    const fees = await this.feeStatus(links.map((l) => l.studentId));
    return links.map((l) => ({
      id: l.student.id,
      fullName: l.student.fullName,
      admissionNo: l.student.admissionNo,
      grade: l.student.section.class.name,
      section: l.student.section.name,
      relationship: l.relationship,
      isPrimary: l.isPrimary,
      attendance: l.student.attendancePct == null ? null : Math.round(l.student.attendancePct * 10) / 10,
      average: l.student.averageScore == null ? null : Math.round(l.student.averageScore),
      risk: l.student.risk,
      feeStatus: fees.get(l.studentId) ?? null,
      status: l.student.status,
    }));
  }

  private async feeStatus(studentIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const fn of this.feeResolvers) {
      try {
        for (const [k, v] of await fn(studentIds)) out.set(k, v);
      } catch {
        // Fee status is informational on this screen; never fail the profile.
      }
    }
    return out;
  }

  private async assertUniquePhone(phone: string, exceptId?: string) {
    const digits = phone.replace(/\D/g, '');
    const tail = digits.slice(-10);
    const candidates = await this.prisma.guardian.findMany({
      where: { phone: { contains: tail.slice(-4) }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true, fullName: true, phone: true },
      take: 200,
    });
    const dup = candidates.find((c) => c.phone.replace(/\D/g, '').slice(-10) === tail);
    if (dup) throw fieldError('phone', `${dup.fullName} already has this phone number`);
  }

  private async linkChildren(guardianId: string, children: NonNullable<ParentDto['children']>) {
    const ids = [...new Set(children.map((c) => c.studentId))];
    const found = await this.prisma.student.count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw fieldError('children', 'One of the students could not be found');
    await this.prisma.$transaction([
      this.prisma.studentGuardian.deleteMany({ where: { guardianId, studentId: { notIn: ids } } }),
      ...children.map((c) =>
        this.prisma.studentGuardian.upsert({
          where: { studentId_guardianId: { studentId: c.studentId, guardianId } },
          create: { studentId: c.studentId, guardianId, relationship: c.relationship?.trim() || 'Guardian', isPrimary: !!c.isPrimary },
          update: { relationship: c.relationship?.trim() || undefined, isPrimary: c.isPrimary ?? undefined },
        }),
      ),
    ]);
  }

  async create(dto: ParentDto, user: AuthUser, req: Request) {
    await this.assertUniquePhone(dto.phone);
    const g = await this.prisma.guardian.create({
      data: {
        fullName: dto.fullName,
        phone: dto.phone,
        email: dto.email?.trim().toLowerCase() || null,
        occupation: dto.occupation?.trim() || null,
        address: dto.address?.trim() || null,
        preferredChannel: dto.preferredChannel ?? 'whatsapp',
        language: dto.language ?? 'en',
      },
    });
    await this.ensureProfiles();
    if (dto.altPhone) await this.prisma.parentProfile.update({ where: { guardianId: g.id }, data: { altPhone: dto.altPhone.trim() } });
    if (dto.children?.length) await this.linkChildren(g.id, dto.children);
    const rec = await this.record(g.id);
    await this.audit.record({
      user, action: 'create', module: 'parents', entityType: 'guardian', entityId: g.id,
      description: `Added parent ${g.fullName} (${rec.parentCode})`, req,
    });
    return rec;
  }

  async update(id: string, dto: ParentDto, user: AuthUser, req: Request) {
    const existing = await this.prisma.guardian.findUnique({ where: { id } });
    if (!existing) throw notFound('Parent');
    await this.assertGuardian(user, id);
    if (existing.phone.replace(/\D/g, '') !== dto.phone.replace(/\D/g, '')) await this.assertUniquePhone(dto.phone, id);
    await this.prisma.guardian.update({
      where: { id },
      data: {
        fullName: dto.fullName,
        phone: dto.phone,
        email: dto.email?.trim().toLowerCase() || null,
        occupation: dto.occupation?.trim() || null,
        address: dto.address?.trim() || null,
        preferredChannel: dto.preferredChannel ?? existing.preferredChannel,
        ...(dto.language ? { language: dto.language } : {}),
      },
    });
    await this.ensureProfiles();
    await this.prisma.parentProfile.update({ where: { guardianId: id }, data: { altPhone: dto.altPhone?.trim() || null } });
    if (dto.children) await this.linkChildren(id, dto.children);
    const changed = (['fullName', 'phone', 'email', 'occupation', 'address', 'preferredChannel'] as const).filter(
      (k) => (dto[k] ?? null) !== (existing[k] ?? null),
    );
    await this.audit.record({
      user, action: 'update', module: 'parents', entityType: 'guardian', entityId: id,
      description: `Updated parent ${dto.fullName}${changed.length ? ` (${changed.join(', ')})` : ''}`, req,
    });
    return this.record(id);
  }
}
