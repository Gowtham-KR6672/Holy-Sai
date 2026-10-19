import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { OpsCertificate, Prisma } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { CurrentUser, Public, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, conflict, fieldError, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { CERTIFICATE_TYPES, CertificateChecksService, CODE_PREFIX } from './certificate-checks.service';
import { day, localDate, OpsContext, todayIso } from './ops.util';

const STATUSES = ['Submitted', 'Under Review', 'Approved', 'Issued', 'Rejected'];
const OPEN = ['Submitted', 'Under Review', 'Approved'];
const ENTITY = 'certificate';

class CertificateQuery extends ListQuery {
  @IsOptional() @IsIn(STATUSES) status?: string;
  @IsOptional() @IsIn(CERTIFICATE_TYPES) type?: string;
}

class RequestDto {
  @IsIn(CERTIFICATE_TYPES, { message: 'Choose a certificate type' }) certificateType: string;
  @IsUUID('all', { message: 'Choose a student' }) studentId: string;
  @IsOptional() @IsString() @MaxLength(200) purpose?: string | null;
}

class DecisionDto {
  @IsIn(['review', 'approve', 'reject', 'issue'], { message: 'Unknown action' }) action: 'review' | 'approve' | 'reject' | 'issue';
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}

const lower = (type: string) => type.charAt(0).toLowerCase() + type.slice(1);
const midnight = (isoDate: string) => new Date(`${isoDate}T00:00:00+05:30`);

/** Certificate requests: automatic checks, Principal approval with a verification code, issue and public verification. */
@Controller('certificates')
@RequirePermissions('documents.read', 'documents.manage')
export class CertificatesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ctx: OpsContext,
    private readonly audit: AuditService,
    private readonly counters: CountersService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly checks: CertificateChecksService,
  ) {}

  private async rows(list: OpsCertificate[]) {
    const students = await this.ctx.students(list.map((c) => c.studentId));
    const campuses = await this.ctx.campusNames();
    return list.map((c) => {
      const s = students.get(c.studentId);
      return {
        id: c.id,
        certificateType: c.certificateType,
        status: c.status,
        purpose: c.purpose,
        requestedOn: day(localDate(c.createdAt)),
        verificationCode: c.verificationCode,
        issuedAt: c.issuedAt?.toISOString() ?? null,
        approvedAt: c.approvedAt?.toISOString() ?? null,
        studentId: c.studentId,
        studentName: s?.fullName ?? c.studentName,
        admissionNo: s?.admissionNo ?? c.admissionNo,
        grade: s?.grade ?? null,
        section: s?.section ?? null,
        campusId: c.campusId,
        campusName: s?.campusName ?? campuses.get(c.campusId) ?? '',
        requestedBy: c.requestedByName,
        approvedBy: c.approvedByName,
        note: c.decisionNote,
      };
    });
  }

  @Get()
  async list(@Query() q: CertificateQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const filter = await this.ctx.studentFilter(user, q.campusId);
    const where: Prisma.OpsCertificateWhereInput = {
      AND: [
        filter,
        q.status ? { status: q.status } : {},
        q.type ? { certificateType: q.type } : {},
        q.q?.trim() ? { OR: [{ studentName: like(q.q) }, { admissionNo: like(q.q) }, { verificationCode: like(q.q) }, { purpose: like(q.q) }] } : {},
      ],
    };
    const dir = q.dir ?? 'desc';
    const orders: Record<string, Prisma.OpsCertificateOrderByWithRelationInput[]> = {
      requested: [{ createdAt: dir }],
      type: [{ certificateType: dir }, { createdAt: 'desc' }],
      student: [{ studentName: dir }, { createdAt: 'desc' }],
      status: [{ status: dir }, { createdAt: 'desc' }],
    };
    const [list, total] = await Promise.all([
      this.prisma.opsCertificate.findMany({ where, orderBy: orders[q.sort ?? 'requested'] ?? orders.requested, skip: p.skip, take: p.take }),
      this.prisma.opsCertificate.count({ where }),
    ]);
    return paged(await this.rows(list), total, p);
  }

  @Get('summary')
  async summary(@Query('campusId') requested: string | undefined, @CurrentUser() user: AuthUser) {
    const filter = await this.ctx.studentFilter(user, requested);
    const [byStatus, issuedThisMonth] = await Promise.all([
      this.prisma.opsCertificate.groupBy({ by: ['status'], where: filter, _count: { _all: true } }),
      this.prisma.opsCertificate.count({ where: { ...filter, status: 'Issued', issuedAt: { gte: midnight(`${todayIso().slice(0, 7)}-01`) } } }),
    ]);
    const n = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
    return { requested: n('Submitted'), underReview: n('Under Review'), approved: n('Approved'), issued: n('Issued'), rejected: n('Rejected'), issuedThisMonth };
  }

  @Get('checks/:studentId')
  async runChecks(@Param('studentId', ParseUUIDPipe) studentId: string, @Query('type') type: string | undefined, @CurrentUser() user: AuthUser) {
    if (!type || !CERTIFICATE_TYPES.includes(type)) throw badRequest('Choose a certificate type');
    await this.scope.assertStudent(user, studentId);
    return this.checks.run(studentId, type);
  }

  /** Public check of a printed verification code. Returns only what is printed on the certificate. */
  @Public()
  @RequirePermissions()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('verify/:code')
  async verify(@Param('code') raw: string) {
    const code = String(raw ?? '').trim().toUpperCase().slice(0, 40);
    if (!/^[A-Z]{2}-\d{4}-\d{3,6}$/.test(code)) return { valid: false, verificationCode: code, reason: 'This is not a valid verification code. Codes look like TC-2026-0341.' };
    const c = await this.prisma.opsCertificate.findUnique({ where: { verificationCode: code } });
    if (!c || c.status === 'Approved' || c.status === 'Submitted' || c.status === 'Under Review') {
      return { valid: false, verificationCode: code, reason: 'No issued certificate carries this code.' };
    }
    if (c.status !== 'Issued') return { valid: false, verificationCode: code, reason: 'This certificate has been withdrawn and is no longer valid.' };
    const [s, campuses, school] = await Promise.all([
      this.ctx.students([c.studentId]).then((m) => m.get(c.studentId)),
      this.ctx.campuses(),
      this.settings.get<string>('school.name', 'Holy Sai International School'),
    ]);
    const campus = campuses.get(c.campusId);
    const issuedOn = c.issuedAt ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(c.issuedAt) : '';
    return {
      valid: true,
      verificationCode: code,
      reason: `Issued by ${school}${issuedOn ? ` on ${issuedOn}` : ''}.`,
      certificateType: c.certificateType,
      status: c.status,
      issuedAt: c.issuedAt?.toISOString(),
      studentName: s?.fullName ?? c.studentName,
      admissionNo: s?.admissionNo ?? c.admissionNo,
      grade: s?.grade ? `${s.grade}${s.section ?? ''}` : undefined,
      campus: campus ? campus.name : undefined,
    };
  }

  /** Approvers: the Principal for the campus, or anyone who manages documents when there is none. */
  private async approvers(campusId: string): Promise<string[]> {
    const principals = await this.ctx.usersWithRoles(['principal'], campusId);
    return principals.length ? principals : this.ctx.usersWithPermission('documents.manage', campusId);
  }

  @Post()
  @RequirePermissions('documents.manage')
  async create(@Body() dto: RequestDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.scope.assertStudent(user, dto.studentId);
    const student = await this.prisma.student.findUnique({ where: { id: dto.studentId }, select: { id: true, fullName: true, admissionNo: true, campusId: true } });
    if (!student) throw fieldError('studentId', 'Choose a student');
    const open = await this.prisma.opsCertificate.findFirst({ where: { studentId: student.id, certificateType: dto.certificateType, status: { in: OPEN } } });
    if (open) throw conflict(`A ${lower(dto.certificateType)} for ${student.fullName} is already ${open.status.toLowerCase()}`);
    const failing = (await this.checks.run(student.id, dto.certificateType)).filter((c) => c.blocking && !c.passed);
    if (failing.length) throw badRequest(`A certificate cannot be issued while a check is failing: ${failing.map((c) => `${c.label} (${c.detail})`).join('; ')}`);
    const c = await this.prisma.opsCertificate.create({
      data: {
        certificateType: dto.certificateType, studentId: student.id, campusId: student.campusId, studentName: student.fullName, admissionNo: student.admissionNo,
        purpose: dto.purpose?.trim() || null, status: 'Submitted', requestedById: user.id, requestedByName: user.fullName,
      },
    });
    await this.audit.record({
      user, action: 'create', module: 'documents', entityType: ENTITY, entityId: c.id, campusId: c.campusId,
      description: `Requested ${lower(c.certificateType)} for ${student.fullName} (${student.admissionNo})${c.purpose ? ` — ${c.purpose}` : ''}`, req,
    });
    const route = `/certificates?q=${encodeURIComponent(student.admissionNo)}`;
    for (const assigneeId of await this.approvers(c.campusId)) {
      await this.notifications.createTask({
        title: `Approve ${lower(c.certificateType)} for ${student.fullName} (${student.admissionNo})`, module: 'documents', assigneeId,
        status: 'Under Review', priority: 'Medium', route, entityType: ENTITY, entityId: c.id,
      });
    }
    return ok({ id: c.id, status: c.status }, 'Certificate sent for approval');
  }

  private async newCode(type: string): Promise<string> {
    const prefix = CODE_PREFIX[type] ?? 'HC';
    const year = todayIso().slice(0, 4);
    const n = await this.counters.next(`ops-certificate-${prefix}-${year}`, 1);
    return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
  }

  @Post(':id/decision')
  @HttpCode(200)
  @RequirePermissions('documents.manage')
  async decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const c = await this.prisma.opsCertificate.findUnique({ where: { id } });
    if (!c) throw notFound('Certificate');
    await this.scope.assertStudent(user, c.studentId);
    const name = c.studentName;
    const note = dto.note?.trim() || null;
    const now = new Date();
    const route = `/certificates?q=${encodeURIComponent(c.admissionNo)}`;
    const blockingFailures = async () => (await this.checks.run(c.studentId, c.certificateType)).filter((x) => x.blocking && !x.passed);
    let data: Prisma.OpsCertificateUpdateInput;
    let message: string;
    let action: 'update' | 'approve' | 'reject' = 'update';
    let description: string;

    switch (dto.action) {
      case 'review': {
        if (c.status !== 'Submitted') throw badRequest(`This request is already ${c.status.toLowerCase()}`);
        data = { status: 'Under Review', reviewedById: user.id, reviewedAt: now };
        message = `${c.certificateType} for ${name} is under review`;
        description = `Marked ${lower(c.certificateType)} for ${name} under review`;
        break;
      }
      case 'approve': {
        if (c.status !== 'Submitted' && c.status !== 'Under Review') throw badRequest(`This request is already ${c.status.toLowerCase()}`);
        const all = await this.checks.run(c.studentId, c.certificateType);
        const failing = all.filter((x) => x.blocking && !x.passed);
        if (failing.length) throw badRequest(`Approval is blocked until the failing checks are resolved: ${failing.map((x) => x.label).join(', ')}`);
        const code = c.verificationCode ?? (await this.newCode(c.certificateType));
        data = {
          status: 'Approved', approvedById: user.id, approvedByName: user.fullName, approvedAt: now, verificationCode: code,
          checks: all as unknown as Prisma.InputJsonValue, ...(note ? { decisionNote: note } : {}),
          ...(c.status === 'Submitted' ? { reviewedById: user.id, reviewedAt: now } : {}),
        };
        message = `Approved — verification code ${code}`;
        action = 'approve';
        description = `Approved ${lower(c.certificateType)} for ${name}; verification code ${code}${note ? ` — ${note}` : ''}`;
        break;
      }
      case 'reject': {
        if (!OPEN.includes(c.status)) throw badRequest(`This request is already ${c.status.toLowerCase()}`);
        if (!note) throw fieldError('note', 'Give a reason for rejecting');
        data = { status: 'Rejected', rejectedById: user.id, rejectedAt: now, decisionNote: note };
        message = `${c.certificateType} for ${name} rejected`;
        action = 'reject';
        description = `Rejected ${lower(c.certificateType)} for ${name} — ${note}`;
        break;
      }
      case 'issue': {
        if (c.status !== 'Approved') throw badRequest(c.status === 'Issued' ? 'This certificate has already been issued' : 'Only approved certificates can be issued');
        const failing = await blockingFailures();
        if (failing.length) throw badRequest(`A certificate cannot be issued while a check is failing: ${failing.map((x) => x.label).join(', ')}`);
        const code = c.verificationCode ?? (await this.newCode(c.certificateType));
        data = { status: 'Issued', issuedById: user.id, issuedAt: now, verificationCode: code };
        message = `${code} issued — it can now be verified`;
        description = `Issued ${lower(c.certificateType)} ${code} for ${name}`;
        break;
      }
    }

    const updated = await this.prisma.opsCertificate.update({ where: { id }, data });
    if (dto.action === 'approve' || dto.action === 'reject') await this.notifications.completeTasksFor(ENTITY, c.id);
    await this.audit.record({ user, action, module: 'documents', entityType: ENTITY, entityId: c.id, campusId: c.campusId, description, req });

    if (c.requestedById && c.requestedById !== user.id && dto.action !== 'review') {
      const titles = {
        approve: { category: 'Information' as const, title: `${c.certificateType} for ${name} approved` },
        reject: { category: 'Attention' as const, title: `${c.certificateType} for ${name} was not approved` },
        issue: { category: 'Completed' as const, title: `${c.certificateType} for ${name} issued` },
      }[dto.action];
      await this.notifications.notifyUsers([c.requestedById], {
        ...titles, module: 'documents', body: dto.action === 'reject' ? `Reason: ${note}` : updated.verificationCode ? `Verification code ${updated.verificationCode}` : undefined,
        route, campusId: c.campusId,
      });
    }
    if (dto.action === 'issue') {
      await this.notifications.notifyGuardians(c.studentId, {
        category: 'Information', module: 'documents', title: `${c.certificateType} issued for ${name}`,
        body: `Collect it from the school office. Verification code ${updated.verificationCode}.`, campusId: c.campusId,
      });
    }
    return ok({ id, status: updated.status, verificationCode: updated.verificationCode }, message);
  }
}
