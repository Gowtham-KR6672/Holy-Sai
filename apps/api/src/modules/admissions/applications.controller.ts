import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { can, type AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, conflict, fieldError, forbidden, notFound } from '../../common/errors';
import { like, pageOf, sortBy } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApplicationQuery, ApplicationStatusDto, CampusQuery, DocumentDto, EnrolDto, OpenApplicationDto } from './admissions.dto';
import { APP_LIVE, APP_TERMINAL, CLOSED, asDate, dateOnly, dayKey, iso, phoneKey, shortDate, stageIndex, todayKey, whenLabel } from './admissions.util';
import { LeadsService, assertId } from './leads.service';
import { StudentLifecycleService } from '../students/lifecycle.service';

const READ = ['admissions.read', 'admissions.manage'];
const DAY = 86_400_000;

/** Allowed moves of the application workflow. */
const NEXT: Record<string, string[]> = {
  Draft: ['Submitted', 'Withdrawn'],
  Submitted: ['Under Review', 'Rejected', 'Withdrawn'],
  'Under Review': ['Assessment Scheduled', 'Offer Made', 'Rejected', 'Withdrawn'],
  'Assessment Scheduled': ['Offer Made', 'Assessment Scheduled', 'Rejected', 'Withdrawn'],
  'Offer Made': ['Accepted', 'Rejected', 'Withdrawn'],
  Accepted: ['Withdrawn'],
};

const DONE_MESSAGE: Record<string, string> = {
  Submitted: 'Application submitted',
  'Under Review': 'Review started',
  'Assessment Scheduled': 'Assessment scheduled',
  'Offer Made': 'Offer made',
  Accepted: 'Offer acceptance recorded',
  Rejected: 'Application rejected',
  Withdrawn: 'Application withdrawn',
};

type AppOrder = Prisma.AdmissionApplicationOrderByWithRelationInput[];
const APP_SORT: Record<string, (d: 'asc' | 'desc') => AppOrder> = {
  created: (d) => [{ createdAt: d }],
  student: (d) => [{ studentName: d }],
  grade: (d) => [{ lead: { gradeLevel: d } }, { grade: d }],
  curriculum: (d) => [{ lead: { curriculum: { sort: d, nulls: 'last' } } }],
  status: (d) => [{ status: d }],
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Applications: document checklist, assessment, offer, decision and enrolment into the Student Master. */
@Controller('applications')
export class ApplicationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly counters: CountersService,
    private readonly lifecycle: StudentLifecycleService,
  ) {}

  @Get()
  @RequirePermissions(...READ)
  async list(@Query() q: ApplicationQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.scope.campus(user, q.campusId);
    const and: Prisma.AdmissionApplicationWhereInput[] = [];
    if (campusId) and.push({ campusId });
    if (q.status === 'live') and.push({ status: { in: APP_LIVE } });
    else if (q.status) and.push({ status: q.status });
    if (q.documents === 'complete') and.push({ documents: { some: {} } }, { documents: { every: { status: 'Verified' } } });
    else if (q.documents === 'incomplete') and.push({ documents: { some: { status: { not: 'Verified' } } } });
    if (q.q?.trim()) {
      const t = q.q.trim();
      and.push({ OR: [{ applicationNo: like(t) }, { studentName: like(t) }, { admissionNo: like(t) }, { lead: { code: like(t) } }, { lead: { parentName: like(t) } }] });
    }
    const where: Prisma.AdmissionApplicationWhereInput = and.length ? { AND: and } : {};
    const orderBy = [...sortBy(q.sort, q.dir ?? 'desc', APP_SORT, 'created'), { createdAt: 'desc' as const }];
    const [rows, total] = await Promise.all([
      this.prisma.admissionApplication.findMany({ where, include: { documents: { select: { status: true } }, lead: true }, orderBy, skip: p.skip, take: p.take }),
      this.prisma.admissionApplication.count({ where }),
    ]);
    const [campuses, staff] = await Promise.all([this.leads.campusNames(rows.map((r) => r.campusId)), this.leads.employeeNames(rows.map((r) => r.lead.counsellorId))]);
    const now = new Date();
    const soonKey = dayKey(new Date(now.getTime() + 7 * DAY));
    return paged(
      rows.map((a) => {
        const total = a.documents.length;
        const verified = a.documents.filter((d) => d.status === 'Verified').length;
        return {
          id: a.id,
          applicationNo: a.applicationNo,
          status: a.status,
          studentName: a.studentName,
          grade: a.grade,
          documentsTotal: total,
          documentsVerified: verified,
          assessmentAt: iso(a.assessmentAt),
          offerExpiresOn: dateOnly(a.offerExpiresOn),
          studentId: a.studentId,
          admissionNo: a.admissionNo,
          campusName: campuses.get(a.campusId) ?? '',
          enquiryId: a.leadId,
          leadCode: a.lead.code,
          parentName: a.lead.parentName,
          curriculum: a.lead.curriculum,
          stage: a.lead.stage,
          counsellor: a.lead.counsellorId ? staff.get(a.lead.counsellorId) ?? a.lead.counsellorName : null,
          blockingItem: this.blockingItem(a.status, total - verified, a.assessmentAt, a.offerExpiresOn, a.admissionNo, now),
          offerExpiring: a.status === 'Offer Made' && !!a.offerExpiresOn && dateOnly(a.offerExpiresOn)! <= soonKey,
          createdAt: a.createdAt.toISOString(),
        };
      }),
      total,
      p,
    );
  }

  @Get('summary')
  @RequirePermissions(...READ)
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const base: Prisma.AdmissionApplicationWhereInput = campusId ? { campusId } : {};
    const yearStart = await this.leads.yearStart();
    const [byStatus, documentsIncomplete, offersIssued, enrolled] = await Promise.all([
      this.prisma.admissionApplication.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
      this.prisma.admissionApplication.count({ where: { ...base, status: { in: APP_LIVE }, documents: { some: { status: { not: 'Verified' } } } } }),
      this.prisma.admissionApplication.count({ where: { ...base, offerMadeAt: { gte: yearStart } } }),
      this.prisma.admissionApplication.count({ where: { ...base, status: 'Enrolled', enrolledAt: { gte: yearStart } } }),
    ]);
    const n = (s: string) => byStatus.find((g) => g.status === s)?._count._all ?? 0;
    return {
      live: APP_LIVE.reduce((sum, s) => sum + n(s), 0),
      documentsIncomplete,
      underReview: n('Under Review'),
      assessmentScheduled: n('Assessment Scheduled'),
      offersIssued,
      offersOpen: n('Offer Made'),
      accepted: n('Accepted'),
      enrolled,
      rejected: n('Rejected'),
      withdrawn: n('Withdrawn'),
      total: byStatus.reduce((sum, g) => sum + g._count._all, 0),
    };
  }

  @Post()
  @RequirePermissions('admissions.manage')
  async open(@Body() dto: OpenApplicationDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const lead = await this.prisma.admissionLead.findUnique({ where: { id: dto.enquiryId } });
    if (!lead) throw fieldError('enquiryId', 'Choose a lead');
    this.scope.campus(user, lead.campusId);
    if (CLOSED.includes(lead.stage)) throw badRequest(`This lead is ${lead.stage.toLowerCase()}; an application cannot be opened`);
    const live = await this.prisma.admissionApplication.findFirst({ where: { leadId: lead.id, status: { in: APP_LIVE } } });
    if (live) throw conflict(`This lead already has an open application (${live.applicationNo})`);
    const { app } = await this.leads.openApplication(lead, user);
    if (stageIndex(lead.stage) < stageIndex('Application')) {
      await this.leads.moveStage(lead, 'Application', `Application ${app.applicationNo} opened`, user);
    }
    await this.audit.record({
      user, action: 'create', module: 'admissions', entityType: 'application', entityId: app.id, campusId: lead.campusId,
      description: `Opened application ${app.applicationNo} for ${lead.studentName} (${lead.code})`, req,
    });
    return ok(this.leads.applicationView(await this.load(app.id)), 'Application opened');
  }

  @Patch(':id/documents/:docId')
  @RequirePermissions('admissions.manage')
  async document(@Param('id') id: string, @Param('docId') docId: string, @Body() dto: DocumentDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertId(id, 'Application');
    assertId(docId, 'Document');
    const app = await this.load(id);
    this.scope.campus(user, app.campusId);
    if (APP_TERMINAL.includes(app.status)) throw badRequest(`This application is ${app.status.toLowerCase()}; its documents can no longer change`);
    const doc = app.documents.find((d) => d.id === docId);
    if (!doc) throw notFound('Document');
    if (doc.status === dto.status) return ok(this.leads.applicationView(app), 'No change');
    const now = new Date();
    await this.prisma.admissionDocument.update({
      where: { id: doc.id },
      data: dto.status === 'Verified'
        ? { status: 'Verified', verifiedAt: now, verifiedById: user.id, receivedAt: doc.receivedAt ?? now }
        : dto.status === 'Submitted'
          ? { status: 'Submitted', receivedAt: now, verifiedAt: null, verifiedById: null }
          : { status: 'Pending', verifiedAt: null, verifiedById: null, ...(doc.status === 'Submitted' ? { receivedAt: null } : {}) },
    });
    const updated = await this.load(id);
    await this.audit.record({
      user, action: dto.status === 'Verified' ? 'approve' : 'update', module: 'admissions', entityType: 'application_document', entityId: doc.id,
      campusId: app.campusId, description: `${app.applicationNo}: ${doc.name} ${doc.status} → ${dto.status}`, req,
    });
    if (dto.status === 'Verified' && updated.documents.every((d) => d.status === 'Verified')) {
      const userId = await this.leads.userOfEmployee(updated.lead.counsellorId);
      if (userId && userId !== user.id) {
        await this.notifications.notifyUsers([userId], {
          category: 'Completed', topic: 'system', module: 'admissions', icon: 'checkSquare', campusId: app.campusId,
          title: `Documents verified: ${app.studentName}`, body: `${app.applicationNo} is ready for assessment or an offer.`, route: `/applications?lead=${updated.lead.code}`,
        });
      }
    }
    const message = dto.status === 'Verified' ? `${doc.name} verified` : dto.status === 'Submitted' ? `${doc.name} marked received` : `${doc.name} set back to pending`;
    return ok(this.leads.applicationView(updated), message);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermissions('admissions.manage')
  async status(@Param('id') id: string, @Body() dto: ApplicationStatusDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertId(id, 'Application');
    const app = await this.load(id);
    this.scope.campus(user, app.campusId);
    const target = dto.status;
    if (!(NEXT[app.status] ?? []).includes(target)) {
      throw badRequest(APP_TERMINAL.includes(app.status) ? `This application is already ${app.status.toLowerCase()}` : `An application that is ${app.status} cannot move to ${target}`);
    }
    const now = new Date();
    const data: Prisma.AdmissionApplicationUpdateInput = { status: target, decidedAt: now, decidedById: user.id, decidedByName: user.fullName };
    if (dto.assessmentScore !== undefined) data.assessmentScore = dto.assessmentScore;
    if (target === 'Assessment Scheduled') {
      if (!dto.assessmentAt) throw fieldError('assessmentAt', 'Choose the assessment date and time');
      const at = new Date(dto.assessmentAt);
      if (at.getTime() < now.getTime() - 5 * 60_000) throw fieldError('assessmentAt', 'Choose a future date and time');
      data.assessmentAt = at;
    }
    if (target === 'Offer Made') {
      const out = app.documents.filter((d) => d.status !== 'Verified').length;
      if (out) throw badRequest(`${plural(out, 'document')} still to verify — offers need every document verified first`);
      if (!dto.offerExpiresOn || dto.offerExpiresOn.slice(0, 10) < todayKey()) throw fieldError('offerExpiresOn', 'Choose a date from today onwards');
      data.offerExpiresOn = asDate(dto.offerExpiresOn);
      data.offerMadeAt = now;
    }
    await this.prisma.admissionApplication.update({ where: { id }, data });

    // The lead follows the application.
    const note = dto.note.trim();
    let lead = app.lead;
    const follow = async (stage: string) => {
      if (!CLOSED.includes(lead.stage) && stageIndex(lead.stage) < stageIndex(stage)) lead = await this.leads.moveStage(lead, stage, `${app.applicationNo}: ${note}`, user);
    };
    if (target === 'Under Review' || target === 'Submitted') await follow('Application');
    if (target === 'Assessment Scheduled') {
      await follow('Assessment');
      await this.scheduleAssessment(app.id, app.applicationNo, lead.id, new Date(dto.assessmentAt!), user);
    }
    if (target === 'Offer Made') {
      await follow('Offer');
      const pending = await this.prisma.admissionFollowUp.findMany({ where: { leadId: lead.id, status: 'Scheduled', type: 'Meeting', notes: `Entrance assessment ${app.applicationNo}` } });
      const score = dto.assessmentScore ?? app.assessmentScore;
      for (const fu of pending) await this.leads.closeFollowUp(fu, 'Completed', `Assessment done${score != null ? ` · score ${score}` : ''}`, null, user);
    }
    if ((target === 'Rejected' || target === 'Withdrawn') && !CLOSED.includes(lead.stage)) {
      lead = await this.leads.moveStage(lead, 'Lost', note, user, { lostReason: target === 'Rejected' ? 'Application rejected' : 'Application withdrawn' });
    }
    await this.prisma.crmCommunication.create({
      data: {
        leadId: lead.id, counterpart: lead.parentName, channel: 'Note', direction: 'Internal', status: 'Internal',
        subject: `Application ${app.applicationNo}: ${app.status} → ${target}`, body: note, sentById: user.id, sentByName: user.fullName,
      },
    });

    // Tell the people who act next.
    const counsellorUser = await this.leads.userOfEmployee(lead.counsellorId);
    if (target === 'Offer Made' && counsellorUser && counsellorUser !== user.id) {
      await this.notifications.notifyUsers([counsellorUser], {
        category: 'Attention', topic: 'system', module: 'admissions', icon: 'award', campusId: app.campusId,
        title: `Offer made: ${app.studentName}`, body: `${app.applicationNo} · valid until ${shortDate(asDate(dto.offerExpiresOn!))}. Follow up with the family.`,
        route: `/applications?lead=${lead.code}`,
      });
    }
    if (target === 'Accepted') {
      await this.notifications.notifyPermission('students.create', {
        category: 'Attention', topic: 'system', module: 'admissions', icon: 'userCheck', campusId: app.campusId,
        title: `Ready to enrol: ${app.studentName}`, body: `${app.applicationNo} · ${app.grade}. The family accepted the offer.`,
        route: `/applications?status=Accepted&lead=${lead.code}`,
      });
    }
    await this.audit.record({
      user,
      action: target === 'Rejected' ? 'reject' : target === 'Offer Made' || target === 'Accepted' ? 'approve' : 'update',
      module: 'admissions', entityType: 'application', entityId: app.id, campusId: app.campusId,
      description: `${app.applicationNo} (${app.studentName}): ${app.status} → ${target}`,
      metadata: { note, assessmentAt: dto.assessmentAt ?? null, offerExpiresOn: dto.offerExpiresOn ?? null, assessmentScore: dto.assessmentScore ?? null }, req,
    });
    const message = target === 'Assessment Scheduled' && app.status === 'Assessment Scheduled' ? 'Assessment rescheduled' : DONE_MESSAGE[target];
    return ok(this.leads.applicationView(await this.load(id)), message);
  }

  @Post(':id/enrol')
  @HttpCode(200)
  @RequirePermissions('admissions.manage')
  async enrol(@Param('id') id: string, @Body() dto: EnrolDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!can(user, 'students.create')) throw forbidden('You need permission to create student records to enrol');
    assertId(id, 'Application');
    const app = await this.load(id);
    this.scope.campus(user, app.campusId);
    if (app.status === 'Enrolled') throw conflict(`${app.studentName} is already enrolled as ${app.admissionNo}`);
    if (app.status !== 'Accepted') throw badRequest('Only an application whose offer has been accepted can be enrolled');
    const today = todayKey();
    if (dto.dateOfBirth.slice(0, 10) >= today) throw fieldError('dateOfBirth', 'Date of birth must be in the past');
    if (dto.admittedOn && dto.admittedOn.slice(0, 10) > today) throw fieldError('admittedOn', 'Admission date cannot be in the future');

    const section = await this.prisma.section.findUnique({ where: { id: dto.sectionId }, include: { class: true, _count: { select: { students: { where: { status: 'active' } } } } } });
    if (!section || section.campusId !== app.campusId) throw fieldError('sectionId', 'Choose a section on the applicant’s campus');
    const sectionLabel = `${section.class.name}${section.name}`;
    if (section._count.students >= section.capacity) throw fieldError('sectionId', `${sectionLabel} is full (${section._count.students}/${section.capacity})`);

    let transport: { routeId: string; stopId: string | null } | null = null;
    if (dto.transport) {
      const route = await this.prisma.transportRoute.findUnique({ where: { id: dto.transport.routeId }, include: { stops: { select: { id: true } } } });
      if (!route || route.campusId !== app.campusId || !route.isActive) throw fieldError('transport.routeId', 'Choose a route on this campus');
      if (dto.transport.stopId && !route.stops.some((s) => s.id === dto.transport!.stopId)) throw fieldError('transport.stopId', 'Choose a stop on this route');
      transport = { routeId: route.id, stopId: dto.transport.stopId ?? null };
    }

    const g = dto.guardian;
    const key = phoneKey(g.phone);
    const match = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Guardian" WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ${key} ORDER BY "createdAt" ASC LIMIT 1`;
    const existingGuardianId = match[0]?.id ?? null;

    const year = (dto.admittedOn ?? today).slice(0, 4);
    let admissionNo = '';
    for (let i = 0; i < 20; i++) {
      admissionNo = await this.counters.reference(`HS-${year}`, `students-${year}`, 4, 1001);
      if (!(await this.prisma.student.findUnique({ where: { admissionNo }, select: { id: true } }))) break;
    }
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    const fullName = `${firstName} ${lastName}`.trim();
    const now = new Date();

    const { student, guardianId, guardianCreated } = await this.prisma.$transaction(async (tx) => {
      const last = await tx.student.aggregate({ where: { sectionId: section.id }, _max: { rollNo: true } });
      const student = await tx.student.create({
        data: {
          admissionNo, firstName, lastName, fullName, dateOfBirth: asDate(dto.dateOfBirth), gender: dto.gender, campusId: app.campusId, sectionId: section.id,
          rollNo: (last._max.rollNo ?? 0) + 1, address: dto.address?.trim() || null, city: dto.city?.trim() || null, pincode: dto.pincode || null,
          admittedOn: asDate(dto.admittedOn ?? today), leadId: app.leadId, status: 'active',
        },
      });
      let guardianId = existingGuardianId;
      if (guardianId) {
        const existing = await tx.guardian.findUniqueOrThrow({ where: { id: guardianId } });
        if (!existing.email && g.email) await tx.guardian.update({ where: { id: guardianId }, data: { email: g.email.trim().toLowerCase() } });
      } else {
        const created = await tx.guardian.create({
          data: { fullName: g.fullName.trim(), phone: g.phone.trim(), email: g.email?.trim().toLowerCase() || null, address: dto.address?.trim() || null },
        });
        guardianId = created.id;
      }
      await tx.studentGuardian.create({ data: { studentId: student.id, guardianId, relationship: g.relationship?.trim() || 'Guardian', isPrimary: true } });
      if (transport) await tx.studentTransport.create({ data: { studentId: student.id, routeId: transport.routeId, stopId: transport.stopId } });
      await tx.admissionApplication.update({
        where: { id: app.id },
        data: {
          status: 'Enrolled', studentId: student.id, admissionNo, enrolledAt: now, decidedAt: now, decidedById: user.id, decidedByName: user.fullName,
          dateOfBirth: asDate(dto.dateOfBirth), gender: dto.gender, studentName: fullName,
        },
      });
      await tx.admissionLead.update({ where: { id: app.leadId }, data: { studentId: student.id } });
      return { student, guardianId, guardianCreated: !existingGuardianId };
    });

    // A returning family: re-enable a parent login that was disabled when an earlier child left.
    if (!guardianCreated) await this.lifecycle.liftGuardianHolds([guardianId]);

    const lead = await this.prisma.admissionLead.findUniqueOrThrow({ where: { id: app.leadId } });
    await this.leads.moveStage(lead, 'Enrolled', `Enrolled as ${admissionNo} in ${sectionLabel}`, user);

    await this.audit.record({
      user, action: 'create', module: 'admissions', entityType: 'student', entityId: student.id, campusId: app.campusId,
      description: `Enrolled ${fullName} as ${admissionNo} in ${sectionLabel} from ${app.applicationNo} (${lead.code}); guardian ${guardianCreated ? 'created' : 'linked'}`,
      metadata: { applicationId: app.id, leadId: lead.id, guardianId, transport }, req,
    });
    await this.notifications.notifyPermission('admissions.manage', {
      category: 'Completed', topic: 'system', module: 'admissions', icon: 'userCheck', campusId: app.campusId,
      title: `${fullName} enrolled`, body: `${admissionNo} · ${sectionLabel} · from ${lead.code}`, route: `/student-360/${student.id}`,
    });
    const teacherUser = await this.leads.userOfEmployee(section.classTeacherId);
    if (teacherUser) {
      await this.notifications.notifyUsers([teacherUser], {
        category: 'Information', topic: 'system', module: 'students', icon: 'userPlus', campusId: app.campusId,
        title: `New student joining ${sectionLabel}`, body: `${fullName} (${admissionNo}) has been admitted.`, route: `/student-360/${student.id}`,
      });
    }
    return ok({ studentId: student.id, admissionNo, section: sectionLabel }, `${fullName} enrolled as ${admissionNo}`);
  }

  // -------------------------------------------------------------------------

  private async load(id: string) {
    const app = await this.prisma.admissionApplication.findUnique({ where: { id }, include: { documents: true, lead: true } });
    if (!app) throw notFound('Application');
    return app;
  }

  /** Puts the entrance assessment on the lead's follow-ups (replacing an earlier booking). */
  private async scheduleAssessment(appId: string, applicationNo: string, leadId: string, at: Date, user: AuthUser) {
    const label = `Entrance assessment ${applicationNo}`;
    const earlier = await this.prisma.admissionFollowUp.findMany({ where: { leadId, status: 'Scheduled', type: 'Meeting', notes: label } });
    for (const fu of earlier) await this.leads.closeFollowUp(fu, 'Cancelled', 'Assessment rescheduled', null, user);
    const lead = await this.prisma.admissionLead.findUniqueOrThrow({ where: { id: leadId } });
    if (CLOSED.includes(lead.stage)) return;
    const owner = lead.counsellorId
      ? await this.prisma.employee.findFirst({ where: { id: lead.counsellorId, archivedAt: null, employmentStatus: { not: 'exited' } }, select: { id: true } })
      : null;
    await this.leads.scheduleFollowUp(lead, { type: 'Meeting', scheduledAt: at, notes: label, assignedTo: owner?.id ?? null }, user);
    void appId;
  }

  private blockingItem(status: string, out: number, assessmentAt: Date | null, offerExpiresOn: Date | null, admissionNo: string | null, now: Date) {
    const docs = out ? `${plural(out, 'document')} to verify` : null;
    switch (status) {
      case 'Draft':
        return 'Submit the application';
      case 'Submitted':
        return docs ?? 'Start the review';
      case 'Under Review':
        return docs ?? 'Schedule the assessment or make an offer';
      case 'Assessment Scheduled':
        if (assessmentAt && assessmentAt > now) return `Assessment ${whenLabel(assessmentAt)}`;
        return docs ?? 'Record the result and make an offer';
      case 'Offer Made':
        if (!offerExpiresOn) return 'Awaiting the family’s reply';
        return dateOnly(offerExpiresOn)! < todayKey()
          ? `Offer expired ${shortDate(offerExpiresOn)}`
          : `Awaiting reply · expires ${shortDate(offerExpiresOn)}`;
      case 'Accepted':
        return 'Ready to enrol';
      case 'Enrolled':
        return admissionNo ? `Enrolled · ${admissionNo}` : 'Enrolled';
      case 'Rejected':
        return 'Application rejected';
      case 'Withdrawn':
        return 'Application withdrawn';
      default:
        return status;
    }
  }
}
