import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { can, type AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { paged } from '../../common/envelope';
import { conflict, fieldError, notFound } from '../../common/errors';
import { like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { FinanceLedgerService } from '../finance/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ParentsService } from '../parents/parents.service';
import { StudentLifecycleService } from './lifecycle.service';
import type { CreateStudentDto, StudentListQuery, UpdateStudentDto } from './students.dto';
import {
  asDate, BLOOD_GROUPS, dayKey, dayKeyOrNull, isDateKey, phoneKey, round1, routeLabel, schoolToday, SENSITIVE,
} from './students.util';

const PHONE = /^\+?[0-9 ]{8,16}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What a register row needs from the database. */
export const ROW_SELECT = {
  id: true, admissionNo: true, fullName: true, firstName: true, lastName: true, sectionId: true, campusId: true, house: true,
  attendancePct: true, averageScore: true, scoreTrend: true, risk: true, photoUrl: true, status: true, discontinuedOn: true,
  section: { select: { name: true, classId: true, class: { select: { name: true, gradeLevel: true } } } },
  campus: { select: { name: true, shortName: true } },
  transport: { select: { route: { select: { code: true, name: true } }, stop: { select: { name: true } } } },
  guardians: { select: { isPrimary: true, guardian: { select: { fullName: true, phone: true } } } },
} satisfies Prisma.StudentSelect;
export type RowRecord = Prisma.StudentGetPayload<{ select: typeof ROW_SELECT }>;

export interface StudentRowView {
  id: string;
  admissionNo: string;
  fullName: string;
  firstName: string;
  lastName: string;
  grade: string | null;
  gradeLevel: number | null;
  section: string | null;
  sectionId: string;
  classId: string | null;
  campusId: string;
  campusName: string;
  campusShort: string;
  house: string | null;
  today: string;
  attendance: number | null;
  average: number | null;
  trend: number;
  risk: string;
  feeStatus: string | null;
  busRoute: string | null;
  photoUrl: string | null;
  parentName: string | null;
  parentPhone: string | null;
  status: string;
  discontinuedOn: string | null;
}

type Dir = 'asc' | 'desc';
const ORDER: Record<string, (d: Dir) => Prisma.StudentOrderByWithRelationInput[]> = {
  name: (d) => [{ fullName: d }, { admissionNo: 'asc' }],
  admissionNo: (d) => [{ admissionNo: d }],
  grade: (d) => [{ section: { class: { gradeLevel: d } } }, { section: { name: d } }, { fullName: 'asc' }],
  attendance: (d) => [{ attendancePct: { sort: d, nulls: 'last' } }, { fullName: 'asc' }],
  average: (d) => [{ averageScore: { sort: d, nulls: 'last' } }, { fullName: 'asc' }],
  trend: (d) => [{ scoreTrend: { sort: d, nulls: 'last' } }, { fullName: 'asc' }],
  // Alphabetical happens to be severity order: At Risk, Developing Risk, On Track.
  risk: (d) => [{ risk: d }, { attendancePct: { sort: 'asc', nulls: 'last' } }, { fullName: 'asc' }],
  house: (d) => [{ house: { sort: d, nulls: 'last' } }, { fullName: 'asc' }],
  admittedOn: (d) => [{ admittedOn: { sort: d, nulls: 'last' } }, { fullName: 'asc' }],
};

/** The student register: list, summary, create and edit. Shared row building for other student lists. */
@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly ledger: FinanceLedgerService,
    private readonly parents: ParentsService,
    private readonly lifecycle: StudentLifecycleService,
  ) {}

  // -------------------------------------------------------------------------
  // Register
  // -------------------------------------------------------------------------

  /** Paged register (also the type-ahead pickers: they read `data` as the row array). */
  async list(user: AuthUser, q: StudentListQuery) {
    const p = pageOf(q, 25);
    const term = q.q?.trim();
    // A search finds former students too (certificates, records); otherwise the register lists current students.
    const status = q.status ?? (term ? 'all' : 'active');
    const and: Prisma.StudentWhereInput[] = [await this.scope.studentWhere(user, q.campusId)];
    if (status === 'inactive') and.push({ status: { not: 'active' } });
    else if (status !== 'all') and.push({ status });
    if (term) {
      const words = term.split(/\s+/).filter(Boolean);
      and.push({
        OR: [
          { fullName: like(term) },
          { admissionNo: like(term) },
          ...(words.length > 1 ? [{ AND: words.map((w) => ({ fullName: like(w) })) }] : []),
        ],
      });
    }
    if (q.grade) and.push({ section: { class: { name: q.grade } } });
    if (q.classId) and.push({ section: { classId: q.classId } });
    if (q.sectionId) and.push({ sectionId: q.sectionId });
    if (q.risk) and.push({ risk: q.risk });
    if (q.house) and.push({ house: q.house });
    const where: Prisma.StudentWhereInput = { AND: and };

    const canFees = can(user, 'finance.read');
    const sortKey = q.sort ?? 'name';
    const dir: Dir = q.dir ?? 'asc';
    const memorySort = sortKey === 'today' || (sortKey === 'feeStatus' && canFees);
    const feeFilter = canFees && q.feeStatus ? q.feeStatus : null;
    const orderBy = [
      ...(status === 'all' ? [{ status: 'asc' as const }] : []),
      ...(ORDER[sortKey] ?? ORDER.name)(dir),
    ];

    if (!q.today && !feeFilter && !memorySort) {
      const [list, total] = await Promise.all([
        this.prisma.student.findMany({ where, orderBy, skip: p.skip, take: p.take, select: ROW_SELECT }),
        this.prisma.student.count({ where }),
      ]);
      return paged(await this.rows(list, user), total, p);
    }

    // Filters on today's attendance or the fee account are computed for every matching student, then paged.
    const all = await this.prisma.student.findMany({ where, orderBy, select: { id: true } });
    let ids = all.map((s) => s.id);
    const today = q.today || sortKey === 'today' ? await this.todayStatuses(ids) : null;
    if (q.today && today) ids = ids.filter((id) => (today.get(id) ?? 'unmarked') === q.today);
    const fees = feeFilter || (sortKey === 'feeStatus' && canFees) ? await this.ledger.accountSummaries(ids) : null;
    if (feeFilter && fees) ids = ids.filter((id) => fees.get(id)?.feeStatus === feeFilter);
    if (memorySort) {
      const key = (id: string) => (sortKey === 'today' ? (today?.get(id) ?? 'unmarked') : (fees?.get(id)?.feeStatus ?? ''));
      const pos = new Map(ids.map((id, i) => [id, i]));
      ids = [...ids].sort((a, b) => key(a).localeCompare(key(b)) * (dir === 'desc' ? -1 : 1) || pos.get(a)! - pos.get(b)!);
    }
    const pageIds = ids.slice(p.skip, p.skip + p.take);
    const list = await this.prisma.student.findMany({ where: { id: { in: pageIds } }, select: ROW_SELECT });
    const byId = new Map(list.map((s) => [s.id, s]));
    return paged(await this.rows(pageIds.map((id) => byId.get(id)!).filter(Boolean), user), ids.length, p);
  }

  /** Risk bands of current students in scope (Students page KPIs, dashboards). */
  async summary(user: AuthUser, campusId?: string) {
    const where: Prisma.StudentWhereInput = { AND: [await this.scope.studentWhere(user, campusId), { status: 'active' }] };
    const groups = await this.prisma.student.groupBy({ by: ['risk'], where, _count: { _all: true } });
    const n = (risk: string) => groups.find((g) => g.risk === risk)?._count._all ?? 0;
    const total = groups.reduce((a, g) => a + g._count._all, 0);
    return { total, atRisk: n('At Risk'), developing: n('Developing Risk'), onTrack: n('On Track') };
  }

  /** Register rows for records loaded with ROW_SELECT. */
  async rows(list: RowRecord[], user: AuthUser): Promise<StudentRowView[]> {
    if (!list.length) return [];
    const ids = list.map((s) => s.id);
    const [today, fees] = await Promise.all([
      this.todayStatuses(ids),
      can(user, 'finance.read') ? this.ledger.accountSummaries(ids) : Promise.resolve(null),
    ]);
    return list.map((s) => {
      const primary = s.guardians.find((g) => g.isPrimary)?.guardian ?? s.guardians[0]?.guardian ?? null;
      return {
        id: s.id,
        admissionNo: s.admissionNo,
        fullName: s.fullName,
        firstName: s.firstName,
        lastName: s.lastName,
        grade: s.section?.class?.name ?? null,
        gradeLevel: s.section?.class?.gradeLevel ?? null,
        section: s.section?.name ?? null,
        sectionId: s.sectionId,
        classId: s.section?.classId ?? null,
        campusId: s.campusId,
        campusName: s.campus?.name ?? '',
        campusShort: s.campus?.shortName ?? '',
        house: s.house,
        today: today.get(s.id) ?? 'unmarked',
        attendance: s.attendancePct == null ? null : round1(s.attendancePct),
        average: s.averageScore == null ? null : round1(s.averageScore),
        trend: round1(s.scoreTrend ?? 0),
        risk: s.risk,
        feeStatus: fees ? (fees.get(s.id)?.feeStatus ?? 'No charges') : null,
        busRoute: s.transport?.route ? routeLabel(s.transport.route.code, s.transport.route.name) : null,
        photoUrl: s.photoUrl,
        parentName: primary?.fullName ?? null,
        parentPhone: primary?.phone ?? null,
        status: s.status,
        discontinuedOn: dayKeyOrNull(s.discontinuedOn),
      };
    });
  }

  /** Today's attendance mark per student: present | late | absent | leave (missing = unmarked). */
  async todayStatuses(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const marks = await this.prisma.studentAttendance.findMany({
      where: { studentId: { in: ids }, date: asDate(schoolToday()) },
      select: { studentId: true, status: true, markedAt: true },
      orderBy: { markedAt: 'asc' },
    });
    return new Map(marks.map((m) => [m.studentId, m.status]));
  }

  // -------------------------------------------------------------------------
  // Create and edit
  // -------------------------------------------------------------------------

  /** The next admission number: HS-<year>-<seq>, from the same counter Admissions enrolment uses. */
  async nextAdmissionNo(admittedOn?: string | null): Promise<string> {
    const year = (admittedOn || schoolToday()).slice(0, 4);
    let admissionNo = '';
    for (let i = 0; i < 50; i++) {
      admissionNo = await this.counters.reference(`HS-${year}`, `students-${year}`, 4, 1001);
      if (!(await this.prisma.student.findUnique({ where: { admissionNo }, select: { id: true } }))) return admissionNo;
    }
    return admissionNo;
  }

  async create(user: AuthUser, dto: CreateStudentDto, req: Request) {
    const today = schoolToday();
    const base = await this.validateBase(user, dto, today);
    const { section, sectionLabel } = base;
    if (section._count.students >= section.capacity) throw fieldError('sectionId', `${sectionLabel} is full (${section._count.students}/${section.capacity})`);

    // Primary guardian
    const g = dto.guardians?.find((x) => x.isPrimary) ?? dto.guardians?.[0];
    const gName = g?.fullName?.trim() ?? '';
    const gPhone = g?.phone?.trim() ?? '';
    const gEmail = g?.email?.trim().toLowerCase() || null;
    if (gName.length < 2) throw fieldError('guardianName', 'Guardian name is required');
    if (gName.length > 120) throw fieldError('guardianName', 'Use at most 120 characters');
    if (!PHONE.test(gPhone)) throw fieldError('guardianPhone', 'Enter a valid phone number');
    if (gEmail && (!EMAIL.test(gEmail) || gEmail.length > 160)) throw fieldError('guardianEmail', 'Enter a valid email');
    const relationship = g?.relationship?.trim().slice(0, 40) || 'Guardian';

    // Transport
    let transport: { routeId: string; stopId: string } | null = null;
    if (dto.transport?.routeId) {
      const route = await this.prisma.transportRoute.findUnique({ where: { id: dto.transport.routeId }, include: { stops: { select: { id: true } } } }).catch(() => null);
      if (!route || route.campusId !== base.campusId || !route.isActive) throw fieldError('routeId', 'Choose a bus route on this campus');
      if (!dto.transport.stopId) throw fieldError('stopId', 'Select the pickup stop');
      if (!route.stops.some((s) => s.id === dto.transport!.stopId)) throw fieldError('stopId', 'Choose a stop on this route');
      transport = { routeId: route.id, stopId: dto.transport.stopId };
    }

    // The same child entered twice (double submit, or already enrolled through Admissions).
    const twin = await this.prisma.student.findFirst({
      where: { firstName: { equals: base.firstName, mode: 'insensitive' }, lastName: { equals: base.lastName, mode: 'insensitive' }, dateOfBirth: asDate(base.dateOfBirth) },
      select: { admissionNo: true, fullName: true, status: true },
    });
    if (twin) throw conflict(`${twin.fullName} with this date of birth is already on record as ${twin.admissionNo}${twin.status !== 'active' ? ` (${twin.status})` : ''}`);

    const match = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "Guardian" WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ${phoneKey(gPhone)} ORDER BY "createdAt" ASC LIMIT 1`;
    const existingGuardianId = match[0]?.id ?? null;
    const admissionNo = await this.nextAdmissionNo(base.admittedOn ?? today);
    const fullName = `${base.firstName} ${base.lastName}`.trim();

    const { student, guardianId } = await this.prisma.$transaction(async (tx) => {
      const last = await tx.student.aggregate({ where: { sectionId: section.id }, _max: { rollNo: true } });
      const student = await tx.student.create({
        data: {
          admissionNo, firstName: base.firstName, lastName: base.lastName, fullName, dateOfBirth: asDate(base.dateOfBirth), gender: dto.gender,
          bloodGroup: base.bloodGroup, campusId: base.campusId, sectionId: section.id, rollNo: (last._max.rollNo ?? 0) + 1, house: base.house,
          address: base.address, city: base.city, pincode: base.pincode, admittedOn: asDate(base.admittedOn ?? today),
          medicalNotes: base.medicalNotes, status: 'active', trackingStatus: dto.enableTracking ? 'active' : 'disabled',
        },
      });
      let guardianId = existingGuardianId;
      if (guardianId) {
        const existing = await tx.guardian.findUniqueOrThrow({ where: { id: guardianId } });
        if (!existing.email && gEmail) await tx.guardian.update({ where: { id: guardianId }, data: { email: gEmail } });
      } else {
        const created = await tx.guardian.create({ data: { fullName: gName, phone: gPhone, email: gEmail, address: base.address } });
        guardianId = created.id;
      }
      await tx.studentGuardian.create({ data: { studentId: student.id, guardianId, relationship, isPrimary: true } });
      if (transport) await tx.studentTransport.create({ data: { studentId: student.id, routeId: transport.routeId, stopId: transport.stopId } });
      return { student, guardianId };
    });

    await this.parents.ensureProfiles().catch(() => undefined);
    // A returning family: a parent account suspended when their other children left is usable again.
    if (existingGuardianId) await this.lifecycle.liftGuardianHolds([guardianId]);

    await this.audit.record({
      user, req, action: 'create', module: 'students', entityType: 'student', entityId: student.id, campusId: base.campusId,
      description: `Created ${fullName} (${admissionNo}) in ${sectionLabel}; guardian ${existingGuardianId ? 'linked' : 'created'}${transport ? '; bus route assigned' : ''}${dto.enableTracking ? '; GPS tracking enabled' : ''}`,
      metadata: { guardianId, transport, sectionId: section.id },
    });
    const teacher = section.classTeacherId
      ? await this.prisma.user.findFirst({ where: { employeeId: section.classTeacherId, status: 'active' }, select: { id: true } })
      : null;
    if (teacher && teacher.id !== user.id) {
      await this.notifications.notifyUsers([teacher.id], {
        category: 'Information', topic: 'system', module: 'students', icon: 'userCheck', campusId: base.campusId,
        title: `New student joining ${sectionLabel}`, body: `${fullName} (${admissionNo}) has been admitted.`, route: `/student-360/${student.id}`,
      });
    }
    return { id: student.id, admissionNo, fullName, section: sectionLabel };
  }

  async update(user: AuthUser, id: string, dto: UpdateStudentDto, req: Request) {
    await this.scope.assertStudent(user, id);
    const s = await this.prisma.student.findUnique({
      where: { id },
      include: { section: { include: { class: true } }, transport: { include: { route: { select: { campusId: true, code: true } } } } },
    });
    if (!s) throw notFound('Student');
    const today = schoolToday();
    const base = await this.validateBase(user, dto, today, s.id);
    const { section, sectionLabel } = base;
    const moving = section.id !== s.sectionId;
    if (moving && s.status === 'active' && section._count.students >= section.capacity) {
      throw fieldError('sectionId', `${sectionLabel} is full (${section._count.students}/${section.capacity})`);
    }
    if (dayKeyOrNull(s.discontinuedOn) && base.admittedOn && base.admittedOn > dayKey(s.discontinuedOn!)) {
      throw fieldError('admittedOn', 'The admission date is after the date the student left');
    }
    const canSensitive = can(user, SENSITIVE);
    const fullName = `${base.firstName} ${base.lastName}`.trim();

    const data: Prisma.StudentUncheckedUpdateInput = {
      firstName: base.firstName, lastName: base.lastName, fullName, dateOfBirth: asDate(base.dateOfBirth), gender: dto.gender,
      bloodGroup: base.bloodGroup, campusId: base.campusId, sectionId: section.id, house: base.house, address: base.address,
      city: base.city, pincode: base.pincode, admittedOn: base.admittedOn ? asDate(base.admittedOn) : null,
      // Medical notes are only sent back by staff who can see them.
      ...(canSensitive ? { medicalNotes: base.medicalNotes } : {}),
    };

    const changes: string[] = [];
    const diff = (label: string, a: unknown, b: unknown) => {
      if ((a ?? null) !== (b ?? null)) changes.push(label);
    };
    diff('name', s.fullName, fullName);
    diff('date of birth', dayKey(s.dateOfBirth), base.dateOfBirth);
    diff('gender', s.gender, dto.gender);
    diff('blood group', s.bloodGroup, base.bloodGroup);
    diff('house', s.house, base.house);
    diff('address', s.address, base.address);
    diff('city', s.city, base.city);
    diff('PIN code', s.pincode, base.pincode);
    diff('admission date', dayKeyOrNull(s.admittedOn), base.admittedOn);
    if (canSensitive) diff('medical notes', s.medicalNotes, base.medicalNotes);
    if (s.campusId !== base.campusId) changes.push('campus');
    if (moving) changes.push(`section ${s.section.class.name}${s.section.name} → ${sectionLabel}`);
    const dropBus = !!s.transport && s.transport.route.campusId !== base.campusId;
    if (dropBus) changes.push(`bus route ${s.transport!.route.code} removed (other campus)`);

    await this.prisma.$transaction(async (tx) => {
      if (moving) {
        const last = await tx.student.aggregate({ where: { sectionId: section.id }, _max: { rollNo: true } });
        data.rollNo = (last._max.rollNo ?? 0) + 1;
      }
      await tx.student.update({ where: { id }, data });
      if (dropBus) await tx.studentTransport.delete({ where: { studentId: id } });
    });

    if (changes.length) {
      await this.audit.record({
        user, req, action: 'update', module: 'students', entityType: 'student', entityId: id, campusId: base.campusId,
        description: `Updated ${fullName} (${s.admissionNo}): ${changes.join(', ')}`,
      });
    }
    return { id, admissionNo: s.admissionNo, changed: changes };
  }

  /** Checks the fields the create and edit forms share; returns the cleaned values and the section. */
  private async validateBase(user: AuthUser, dto: CreateStudentDto | UpdateStudentDto, today: string, studentId?: string) {
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    if (!firstName) throw fieldError('firstName', 'First name is required');
    if (!lastName) throw fieldError('lastName', 'Last name is required');
    if (!isDateKey(dto.dateOfBirth)) throw fieldError('dateOfBirth', 'Date of birth is required');
    if (dto.dateOfBirth >= today) throw fieldError('dateOfBirth', 'Date of birth must be in the past');
    if (dto.dateOfBirth < '1950-01-01') throw fieldError('dateOfBirth', 'Check the date of birth');

    const campus = await this.prisma.campus.findUnique({ where: { id: dto.campusId } }).catch(() => null);
    if (!campus) throw fieldError('campusId', 'Select a campus');
    this.scope.campus(user, campus.id);

    const section = await this.prisma.section.findUnique({
      where: { id: dto.sectionId },
      include: { class: true, _count: { select: { students: { where: { status: 'active', ...(studentId ? { NOT: { id: studentId } } : {}) } } } } },
    }).catch(() => null);
    if (!section) throw fieldError('sectionId', 'Select a class and section');
    if (section.campusId !== campus.id) throw fieldError('sectionId', 'Choose a section on this campus');
    const sectionLabel = `${section.class.name}${section.name}`;

    const opt = (v: string | undefined | null) => (v && v.trim() ? v.trim() : null);
    const pincode = opt(dto.pincode);
    if (pincode && !/^[0-9]{6}$/.test(pincode)) throw fieldError('pincode', 'PIN code must be 6 digits');
    const admittedOn = opt(dto.admittedOn);
    if (admittedOn && !isDateKey(admittedOn)) throw fieldError('admittedOn', 'Use a valid date');
    if (admittedOn && admittedOn > today) throw fieldError('admittedOn', 'Admission date cannot be in the future');
    if (admittedOn && admittedOn < dto.dateOfBirth) throw fieldError('admittedOn', 'Admission date is before the date of birth');
    const bloodGroup = opt(dto.bloodGroup);
    if (bloodGroup && !(BLOOD_GROUPS as readonly string[]).includes(bloodGroup)) throw fieldError('bloodGroup', 'Choose a blood group');

    return {
      firstName, lastName, dateOfBirth: dto.dateOfBirth, campusId: campus.id, section, sectionLabel,
      bloodGroup, house: opt(dto.house), address: opt(dto.address), city: opt(dto.city), pincode, admittedOn,
      medicalNotes: opt(dto.medicalNotes),
    };
  }
}
