import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { OpsDocument, Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { can, type AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DATE_RE, dateOf, day, daysBetween, isRealDate, localDate, OpsContext, today, todayIso } from './ops.util';
import { StorageService, type UploadedFileLike } from './storage.service';

const MAX_MB = 10;
const UNFILED = 'Unfiled';
const READ = ['documents.read', 'documents.manage'];

class SchoolDocQuery extends ListQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() @MaxLength(80) collection?: string;
}

class PendingQuery extends ListQuery {
  @IsOptional() @IsIn(['Submitted', 'Pending']) status?: string;
}

class UploadDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsString() @MaxLength(80) collection?: string;
  @IsOptional() @IsUUID() studentId?: string;
  @IsOptional() @IsUUID() documentId?: string;
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'Enter a valid expiry date' }) expiresOn?: string;
}

class RequestDocDto {
  @IsUUID('all', { message: 'Choose a student' }) studentId: string;
  @IsString() @MinLength(2, { message: 'Name the document' }) @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}

class VerifyDto {
  @IsIn(['Verified', 'Rejected'], { message: 'Choose Verified or Rejected' }) status: 'Verified' | 'Rejected';
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}

/** Status as shown: a verified document past its expiry date reads "Expired". */
export function documentStatus(d: Pick<OpsDocument, 'status' | 'expiresOn'>, t = today()): string {
  if (d.status === 'Verified' && d.expiresOn && d.expiresOn.getTime() < t.getTime()) return 'Expired';
  return d.status;
}

function statusWhere(status: string | undefined, t: Date): Prisma.OpsDocumentWhereInput {
  if (!status) return {};
  if (status === 'Expired') return { OR: [{ status: 'Expired' }, { status: 'Verified', expiresOn: { lt: t } }] };
  if (status === 'Verified') return { status: 'Verified', OR: [{ expiresOn: null }, { expiresOn: { gte: t } }] };
  return { status };
}

/** School document sets, student documents with a verification queue, protected uploads and downloads. */
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ctx: OpsContext,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
  ) {}

  /** School documents visible in a campus view: campus-wide ones plus those filed for that campus. */
  private schoolWhere(campusId: string | undefined): Prisma.OpsDocumentWhereInput {
    return { studentId: null, ...(campusId ? { OR: [{ campusId: null }, { campusId }] } : {}) };
  }

  @Get('summary')
  @RequirePermissions(...READ)
  async summary(@Query('campusId') requested: string | undefined, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, requested);
    const t = today();
    const school = this.schoolWhere(campusId);
    const student: Prisma.OpsDocumentWhereInput = { studentId: { not: null }, ...(await this.ctx.studentFilter(user, requested)) };
    const scoped: Prisma.OpsDocumentWhereInput = { OR: [school, student] };
    const count = (where: Prisma.OpsDocumentWhereInput) => this.prisma.opsDocument.count({ where });
    const [schoolFiles, studentFiles, pendingVerification, awaitingUpload, rejected, expired, sets, storage] = await Promise.all([
      count({ AND: [school, { storageKey: { not: null } }] }),
      count({ AND: [student, { storageKey: { not: null } }] }),
      count({ AND: [scoped, { status: 'Submitted' }] }),
      count({ AND: [student, { status: 'Pending' }] }),
      count({ AND: [scoped, { status: 'Rejected' }] }),
      count({ AND: [scoped, statusWhere('Expired', t)] }),
      this.prisma.opsDocument.groupBy({ by: ['collection'], where: school }),
      this.prisma.opsDocument.aggregate({ where: { AND: [scoped, { storageKey: { not: null } }] }, _sum: { sizeBytes: true } }),
    ]);
    return {
      total: schoolFiles + studentFiles,
      school: schoolFiles,
      student: studentFiles,
      pendingVerification,
      awaitingUpload,
      rejected,
      expired,
      collections: sets.length,
      storageBytes: storage._sum.sizeBytes ?? 0,
    };
  }

  @Get('collections')
  @RequirePermissions(...READ)
  async collections(@Query('q') q?: string) {
    const docs = await this.prisma.opsDocument.findMany({
      where: { studentId: null },
      select: { collection: true, status: true, storageKey: true, updatedAt: true, createdAt: true, uploadedByName: true },
      orderBy: { createdAt: 'asc' },
    });
    const sets = new Map<string, { name: string; count: number; pending: number; files: number; updatedAt: Date; owner: string | null }>();
    for (const d of docs) {
      const name = d.collection || UNFILED;
      const s = sets.get(name) ?? { name, count: 0, pending: 0, files: 0, updatedAt: d.updatedAt, owner: d.uploadedByName };
      s.count += 1;
      if (d.status === 'Submitted') s.pending += 1;
      if (d.storageKey) s.files += 1;
      if (d.updatedAt > s.updatedAt) s.updatedAt = d.updatedAt;
      sets.set(name, s);
    }
    const term = q?.trim().toLowerCase();
    return [...sets.values()]
      .filter((s) => !term || s.name.toLowerCase().includes(term))
      .sort((a, b) => (a.name === UNFILED ? 1 : b.name === UNFILED ? -1 : a.name.localeCompare(b.name)))
      .map((s) => ({ ...s, updatedAt: s.updatedAt.toISOString() }));
  }

  @Get('school')
  @RequirePermissions(...READ)
  async school(@Query() q: SchoolDocQuery) {
    const p = pageOf(q);
    const t = today();
    const where: Prisma.OpsDocumentWhereInput = {
      AND: [
        { studentId: null },
        q.collection ? { collection: q.collection === UNFILED ? null : q.collection } : {},
        statusWhere(q.status, t),
        q.q?.trim() ? { OR: [{ name: like(q.q) }, { originalName: like(q.q) }, { category: like(q.q) }] } : {},
      ],
    };
    const dir = q.dir ?? 'desc';
    const orders: Record<string, Prisma.OpsDocumentOrderByWithRelationInput[]> = {
      updated: [{ updatedAt: dir }],
      name: [{ name: dir }],
      status: [{ status: dir }, { updatedAt: 'desc' }],
      size: [{ sizeBytes: { sort: dir, nulls: 'last' } }],
    };
    const [rows, total] = await Promise.all([
      this.prisma.opsDocument.findMany({ where, orderBy: orders[q.sort ?? 'updated'] ?? orders.updated, skip: p.skip, take: p.take }),
      this.prisma.opsDocument.count({ where }),
    ]);
    return paged(
      rows.map((d) => ({
        id: d.id,
        name: d.name,
        category: d.category,
        collection: d.collection ?? UNFILED,
        status: documentStatus(d, t),
        hasFile: !!d.storageKey,
        originalName: d.originalName,
        sizeBytes: d.sizeBytes,
        mimeType: d.mimeType,
        uploadedBy: d.uploadedByName,
        uploadedAt: d.uploadedAt?.toISOString() ?? null,
        updatedAt: d.updatedAt.toISOString(),
        verifiedBy: d.verifiedByName,
        verifiedAt: d.verifiedAt?.toISOString() ?? null,
        expiresOn: day(d.expiresOn),
        note: d.reviewNote,
      })),
      total,
      p,
    );
  }

  /** Student documents waiting on the school (uploaded, to verify) or on the family (requested, not uploaded). */
  @Get('pending')
  @RequirePermissions(...READ)
  async pending(@Query() q: PendingQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const filter = await this.ctx.studentFilter(user, q.campusId);
    let search: Prisma.OpsDocumentWhereInput = {};
    if (q.q?.trim()) {
      const studentWhere = await this.scope.studentWhere(user, q.campusId);
      const matches = await this.prisma.student.findMany({
        where: { AND: [studentWhere, { OR: [{ fullName: like(q.q) }, { admissionNo: like(q.q) }] }] },
        select: { id: true },
        take: 500,
      });
      search = { OR: [{ name: like(q.q) }, { category: like(q.q) }, { studentId: { in: matches.map((s) => s.id) } }] };
    }
    const where: Prisma.OpsDocumentWhereInput = {
      AND: [{ studentId: { not: null } }, filter, { status: q.status ? q.status : { in: ['Submitted', 'Pending'] } }, search],
    };
    const [rows, total] = await Promise.all([
      this.prisma.opsDocument.findMany({
        where,
        orderBy: [
          { status: 'desc' },
          { uploadedAt: { sort: 'asc', nulls: 'last' } },
          { requestedOn: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'asc' },
        ],
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.opsDocument.count({ where }),
    ]);
    const students = await this.ctx.students(rows.map((d) => d.studentId!));
    const t = today();
    return paged(
      rows.map((d) => {
        const s = students.get(d.studentId!);
        const since = d.status === 'Submitted' ? localDate(d.uploadedAt ?? d.updatedAt) : d.requestedOn ?? localDate(d.createdAt);
        return {
          id: d.id,
          name: d.name,
          category: d.category,
          status: d.status,
          hasFile: !!d.storageKey,
          requestedOn: day(d.requestedOn),
          updatedAt: d.updatedAt.toISOString(),
          uploadedBy: d.uploadedByName,
          studentId: d.studentId!,
          studentName: s?.fullName ?? 'Unknown student',
          admissionNo: s?.admissionNo ?? '',
          grade: s?.grade ?? null,
          section: s?.section ?? null,
          campusName: s?.campusName ?? '',
          waitingDays: Math.max(0, daysBetween(since, t)),
        };
      }),
      total,
      p,
    );
  }

  /**
   * Upload (multipart: file + fields). School documents go into a named set (documents.manage);
   * student documents need `studentId` and may fulfil a requested document via `documentId`.
   */
  @Post()
  @RequirePermissions('documents.manage', 'students.update', 'parent_portal.use')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: (MAX_MB + 2) * 1024 * 1024, files: 1 }, defParamCharset: 'utf8' }))
  async upload(@UploadedFile() file: UploadedFileLike | undefined, @Body() dto: UploadDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!file) throw fieldError('file', 'Choose a file');
    if (file.size > MAX_MB * 1024 * 1024) throw fieldError('file', `Files must be ${MAX_MB} MB or smaller`);
    if (dto.expiresOn && !isRealDate(dto.expiresOn)) throw fieldError('expiresOn', 'Enter a valid expiry date');
    const manage = can(user, 'documents.manage');

    let existing: OpsDocument | null = null;
    if (dto.documentId) {
      existing = await this.prisma.opsDocument.findUnique({ where: { id: dto.documentId } });
      if (!existing) throw notFound('Document');
      if (dto.studentId && existing.studentId !== dto.studentId) throw badRequest('This document belongs to another record');
      if (existing.status === 'Verified' && !manage) throw badRequest('This document is already verified');
    }
    const studentId = existing ? existing.studentId : dto.studentId ?? null;
    let student: { id: string; fullName: string; admissionNo: string; campusId: string } | null = null;
    if (studentId) {
      await this.scope.assertStudent(user, studentId);
      student = await this.prisma.student.findUnique({ where: { id: studentId }, select: { id: true, fullName: true, admissionNo: true, campusId: true } });
      if (!student) throw notFound('Student');
    } else if (!manage) {
      throw forbidden('Only staff with document access can upload school documents');
    }

    const name = (dto.name?.trim() || existing?.name || '').slice(0, 160);
    if (name.length < 2) throw fieldError('name', name ? 'Name is too short' : 'Name is required');
    const collection = studentId ? null : dto.collection?.trim() || existing?.collection || '';
    if (!studentId && !collection) throw fieldError('collection', 'Choose or name a document set');
    if (collection === UNFILED) throw fieldError('collection', 'Choose or name a document set');
    if (dto.employeeId && !(await this.prisma.employee.findUnique({ where: { id: dto.employeeId }, select: { id: true } }))) throw fieldError('employeeId', 'Choose a staff member');

    const stored = await this.storage.save(file, studentId ? 'documents/students' : 'documents/school');
    const now = new Date();
    const fileData = {
      storageKey: stored.key, originalName: stored.originalName, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256,
      status: 'Submitted', uploadedById: user.id, uploadedByName: user.fullName, uploadedAt: now,
      verifiedById: null, verifiedByName: null, verifiedAt: null, reviewNote: null,
    };
    let doc: OpsDocument;
    try {
      if (existing) {
        doc = await this.prisma.opsDocument.update({
          where: { id: existing.id },
          data: { ...fileData, name, ...(dto.category?.trim() ? { category: dto.category.trim() } : {}), ...(dto.expiresOn ? { expiresOn: dateOf(dto.expiresOn) } : {}) },
        });
      } else {
        doc = await this.prisma.opsDocument.create({
          data: {
            ...fileData, name, category: dto.category?.trim() || (studentId ? 'Student' : 'General'), collection: collection || null,
            studentId, employeeId: dto.employeeId ?? null, campusId: student?.campusId ?? null,
            expiresOn: dto.expiresOn ? dateOf(dto.expiresOn) : null,
          },
        });
      }
    } catch (err) {
      await this.storage.remove(stored.key);
      throw err;
    }
    if (existing?.storageKey) await this.storage.remove(existing.storageKey);

    const whose = student ? ` for ${student.fullName} (${student.admissionNo})` : ` to ${collection}`;
    await this.audit.record({
      user, action: existing ? 'update' : 'create', module: 'documents', entityType: 'document', entityId: doc.id, campusId: doc.campusId,
      description: `Uploaded “${name}”${whose} (${stored.originalName}, ${Math.round(stored.sizeBytes / 1024)} KB)`, req,
    });
    if (!manage) {
      const recipients = await this.ctx.usersWithPermission('documents.manage', doc.campusId);
      await this.notifications.notifyUsers(recipients, {
        category: 'Attention', module: 'documents', title: `New document to verify: ${name}`,
        body: `Uploaded by ${user.fullName}${whose}.`, route: '/documents?tab=queue', campusId: doc.campusId,
      });
    }
    return ok({ id: doc.id, name: doc.name, status: doc.status, hasFile: true, sizeBytes: doc.sizeBytes }, 'Document uploaded — awaiting verification');
  }

  /** Asks the family for a student document; it waits in the queue as "requested, not uploaded". */
  @Post('requests')
  @RequirePermissions('documents.manage')
  async request(@Body() dto: RequestDocDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.scope.assertStudent(user, dto.studentId);
    const student = await this.prisma.student.findUnique({ where: { id: dto.studentId }, select: { id: true, fullName: true, admissionNo: true, campusId: true } });
    if (!student) throw fieldError('studentId', 'Choose a student');
    const name = dto.name.trim();
    const open = await this.prisma.opsDocument.findFirst({
      where: { studentId: student.id, name: { equals: name, mode: 'insensitive' }, status: { in: ['Pending', 'Submitted'] } },
    });
    if (open) throw fieldError('name', open.status === 'Pending' ? 'This document has already been requested' : 'This document has been uploaded and is awaiting verification');
    const doc = await this.prisma.opsDocument.create({
      data: {
        studentId: student.id, campusId: student.campusId, name, category: dto.category?.trim() || 'Student', status: 'Pending',
        requestedOn: dateOf(todayIso()), requestedById: user.id, reviewNote: dto.note?.trim() || null,
      },
    });
    await this.audit.record({
      user, action: 'create', module: 'documents', entityType: 'document', entityId: doc.id, campusId: doc.campusId,
      description: `Requested “${name}” for ${student.fullName} (${student.admissionNo})`, req,
    });
    await this.notifications.notifyGuardians(student.id, {
      category: 'Attention', module: 'documents', title: `Please upload ${name} for ${student.fullName}`,
      body: dto.note?.trim() || 'The school office has requested this document.', campusId: student.campusId, deliver: true,
    });
    return ok({ id: doc.id, status: doc.status }, `Requested “${name}” from the family`);
  }

  @Get(':id/download')
  @RequirePermissions('documents.read', 'documents.manage', 'students.read', 'students.read_assigned', 'students.update', 'parent_portal.use')
  async download(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const d = await this.prisma.opsDocument.findUnique({ where: { id } });
    if (!d) throw notFound('Document');
    if (d.studentId) await this.scope.assertStudent(user, d.studentId);
    else if (!can(user, ...READ)) throw forbidden('This document is not available to you');
    if (!d.storageKey) throw notFound('File');
    const ext = d.originalName?.match(/\.[a-z0-9]+$/i)?.[0] ?? '';
    const fileName = d.originalName ?? `${d.name}${ext}`;
    const stream = await this.storage.open(d.storageKey, fileName, d.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    await this.audit.record({ user, action: 'view', module: 'documents', entityType: 'document', entityId: d.id, campusId: d.campusId, description: `Downloaded “${d.name}”`, req });
    return stream;
  }

  @Patch(':id/verify')
  @RequirePermissions('documents.manage')
  async verify(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VerifyDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const d = await this.prisma.opsDocument.findUnique({ where: { id } });
    if (!d) throw notFound('Document');
    if (d.studentId) await this.scope.assertStudent(user, d.studentId);
    if (d.status !== 'Submitted') {
      throw badRequest(d.status === 'Pending' ? 'This document has not been uploaded yet' : `This document is already ${d.status.toLowerCase()}`);
    }
    if (!d.storageKey) throw badRequest('There is no file to verify');
    const note = dto.note?.trim() || null;
    await this.prisma.opsDocument.update({
      where: { id },
      data: { status: dto.status, verifiedById: user.id, verifiedByName: user.fullName, verifiedAt: new Date(), reviewNote: note },
    });
    const student = d.studentId ? (await this.ctx.students([d.studentId])).get(d.studentId) : undefined;
    const whose = student ? ` for ${student.fullName} (${student.admissionNo})` : d.collection ? ` in ${d.collection}` : '';
    await this.audit.record({
      user, action: dto.status === 'Verified' ? 'approve' : 'reject', module: 'documents', entityType: 'document', entityId: id, campusId: d.campusId,
      description: `${dto.status === 'Verified' ? 'Verified' : 'Rejected'} “${d.name}”${whose}${note ? ` — ${note}` : ''}`, req,
    });
    if (d.uploadedById && d.uploadedById !== user.id) {
      const isParent = !!(await this.prisma.user.count({ where: { id: d.uploadedById, parentId: { not: null } } }));
      await this.notifications.notifyUsers([d.uploadedById], {
        category: dto.status === 'Verified' ? 'Completed' : 'Attention',
        module: 'documents',
        title: dto.status === 'Verified' ? `“${d.name}” has been verified` : `“${d.name}” was rejected`,
        body: dto.status === 'Rejected' ? (note ? `Reason: ${note}. Please upload a corrected copy.` : 'Please upload a corrected copy.') : undefined,
        route: isParent ? undefined : student ? `/student-360/${student.id}` : '/documents',
        campusId: d.campusId,
        deliver: dto.status === 'Rejected' && isParent,
      });
    }
    return ok({ id, status: dto.status }, dto.status === 'Verified' ? `“${d.name}” verified` : `“${d.name}” rejected — uploader notified`);
  }
}
