import { Body, Controller, Get, Headers, HttpCode, Post, Query, Req, StreamableFile } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, Public, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { AppError, fieldError, unavailable } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { GateEventsService } from './gate.service';
import { GATE_METHODS, isDate, SafetyContext, sortRows } from './safety.util';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class GateLogQuery extends ListQuery {
  @IsOptional() @Matches(DATE_RE, { message: 'Use a YYYY-MM-DD date' }) date?: string;
  @IsOptional() @IsIn(['Inside', 'Exited', 'Not arrived']) status?: string;
  @IsOptional() @IsUUID() classId?: string;
}

class GateEventsQuery extends ListQuery {
  @IsOptional() @Matches(DATE_RE, { message: 'Use a YYYY-MM-DD date' }) date?: string;
  @IsOptional() @IsIn(['in', 'out']) direction?: string;
  @IsOptional() @IsString() @MaxLength(60) gate?: string;
  @IsOptional() @IsString() @MaxLength(20) method?: string;
}

class ExportQuery {
  @IsOptional() @Matches(DATE_RE, { message: 'Use a YYYY-MM-DD date' }) date?: string;
  @IsOptional() @IsString() campusId?: string;
}

class GateEventDto {
  @IsUUID('all', { message: 'Choose a student' }) studentId: string;
  @IsIn(['in', 'out'], { message: 'Choose entry or exit' }) direction: 'in' | 'out';
  @IsString() @MaxLength(60) gate: string;
  @IsOptional() @IsString() @MaxLength(20) method?: string;
}

class StudentSearchQuery {
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @IsUUID() routeId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @IsString() campusId?: string;
}

const csv = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const METHOD_ALIASES: Record<string, string> = {
  rfid: 'RFID', card: 'RFID', nfc: 'RFID', face: 'Face', qr: 'QR', manual: 'Manual', bus: 'Bus',
};

@Controller('gate')
export class GateController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: SafetyContext,
    private readonly gate: GateEventsService,
    private readonly audit: AuditService,
    private readonly integrations: IntegrationsService,
  ) {}

  @Get('summary')
  @RequirePermissions('safety.read', 'safety.manage')
  summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    return this.gate.summary(user, q.campusId);
  }

  @Get('feed')
  @RequirePermissions('safety.read', 'safety.manage')
  feed(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    return this.gate.feed(user, q.campusId);
  }

  /** One row per student for a day: first entry, last exit, status and parent notifications. */
  @Get('log')
  @RequirePermissions('safety.read', 'safety.manage')
  async log(@Query() q: GateLogQuery, @CurrentUser() user: AuthUser) {
    const clock = await this.ctx.clock();
    const date = isDate(q.date) ? q.date : clock.today();
    const p = pageOf(q);
    const rows = await this.gate.log(user, { campusId: q.campusId, date, status: q.status, classId: q.classId, q: q.q });
    const statusOrder: Record<string, number> = { Inside: 0, Exited: 1, 'Not arrived': 2 };
    const sorted = sortRows(rows, q.sort, q.dir, {
      name: (r) => r.fullName,
      entry: (r) => r.firstIn,
      exit: (r) => r.lastOut,
      status: (r) => statusOrder[r.status],
    }, 'name');
    return paged(sorted.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  /** Every scan on a day. */
  @Get('events')
  @RequirePermissions('safety.read', 'safety.manage')
  async events(@Query() q: GateEventsQuery, @CurrentUser() user: AuthUser) {
    const clock = await this.ctx.clock();
    const date = isDate(q.date) ? q.date : clock.today();
    const p = pageOf(q, 50);
    const recordWhere = await this.ctx.recordWhere(user, q.campusId);
    const where: Prisma.SafetyGateEventWhereInput = {
      ...recordWhere,
      day: clock.dayValue(date),
      ...(q.direction ? { direction: q.direction } : {}),
      ...(q.gate ? { gate: q.gate } : {}),
      ...(q.method ? { method: q.method } : {}),
    };
    if (q.q?.trim()) {
      const ids = await this.ctx.matchingStudentIds(user, q.q, q.campusId);
      where.AND = [{ studentId: { in: ids } }];
    }
    const events = await this.prisma.safetyGateEvent.findMany({ where, orderBy: { occurredAt: 'desc' }, take: 20_000 });
    const students = await this.ctx.students(events.map((e) => e.studentId));
    const rows = events.map((e) => this.gate.row(e, students.get(e.studentId)));
    const sorted = sortRows(rows, q.sort, q.dir, {
      time: (r) => r.occurredAt,
      name: (r) => r.fullName,
      gate: (r) => r.gate,
      method: (r) => r.method,
    }, 'time', 'desc');
    return paged(sorted.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  /** CSV of every scan on a day. */
  @Get('events/export')
  @RequirePermissions('safety.read', 'safety.manage')
  async export(@Query() q: ExportQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const clock = await this.ctx.clock();
    const date = isDate(q.date) ? q.date : clock.today();
    const recordWhere = await this.ctx.recordWhere(user, q.campusId);
    const events = await this.prisma.safetyGateEvent.findMany({ where: { ...recordWhere, day: clock.dayValue(date) }, orderBy: { occurredAt: 'asc' } });
    const students = await this.ctx.students(events.map((e) => e.studentId));
    const lines = [['Date', 'Time', 'Admission no', 'Student', 'Class', 'Campus', 'Direction', 'Gate', 'Method', 'Parent notified at'].join(',')];
    for (const e of events) {
      const s = students.get(e.studentId);
      lines.push([
        date,
        clock.time(e.occurredAt),
        s?.admissionNo ?? '',
        s?.fullName ?? '',
        s ? `${s.grade ?? ''}${s.section ?? ''}` : '',
        s?.campusName ?? '',
        e.direction === 'in' ? 'Entry' : 'Exit',
        e.gate,
        e.method,
        e.parentNotifiedAt ? clock.time(e.parentNotifiedAt) : '',
      ].map(csv).join(','));
    }
    await this.audit.record({
      user, action: 'export', module: 'safety', entityType: 'gate_log', description: `Exported the gate log for ${date} (${events.length} scans)`,
      campusId: this.ctx.campus(user, q.campusId) ?? null, req,
    });
    return new StreamableFile(Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="gate-log-${date}.csv"`,
    });
  }

  /** Manual entry / exit when a reader is unavailable. */
  @Post('events')
  @RequirePermissions('safety.manage')
  async create(@Body() dto: GateEventDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { gates } = await this.ctx.gates();
    const gate = [...new Set([...gates, 'Main Gate', 'Rear Gate', 'Visitor Gate', 'Bus Bay'])].find((g) => g.toLowerCase() === dto.gate.trim().toLowerCase());
    if (!gate) throw fieldError('gate', 'Choose a gate');
    const method = dto.method ? METHOD_ALIASES[dto.method.trim().toLowerCase()] ?? (GATE_METHODS.includes(dto.method) ? dto.method : null) : 'Manual';
    if (!method) throw fieldError('method', 'Unknown scan method');
    const student = await this.ctx.assertStudent(user, dto.studentId);
    const r = await this.gate.record({ studentId: student.id, direction: dto.direction, gate, method, source: 'manual', recordedById: user.id }, student);
    if (r.duplicate) throw new AppError(409, 'CONFLICT', `This ${dto.direction === 'in' ? 'entry' : 'exit'} was already recorded a moment ago`);
    await this.audit.record({
      user, action: 'create', module: 'safety', entityType: 'gate_event', entityId: r.event.id, campusId: student.campusId, req,
      description: `Recorded manual ${dto.direction === 'in' ? 'entry' : 'exit'} for ${student.fullName} (${student.admissionNo}) at the ${gate}`,
    });
    const verb = dto.direction === 'in' ? 'Entry' : 'Exit';
    return ok(this.gate.row(r.event, student), r.notified ? `${verb} recorded — parents notified` : `${verb} recorded`);
  }

  /**
   * Card / face readers post scans here. Secured by the gate integration's webhook secret, sent either as
   * a shared secret (X-Gate-Secret, X-Webhook-Secret or "Authorization: Bearer <secret>") or as an HMAC-SHA256
   * hex signature of the JSON body (X-Gate-Signature / X-Signature, optionally prefixed "sha256=").
   * Body: one scan or { events: [...] }, each { studentId | admissionNo | cardNo, direction?, gate?, method?, occurredAt?, deviceId? }.
   */
  @Public()
  @Post('webhooks/scan')
  @HttpCode(200)
  async webhook(@Body() body: Record<string, unknown>, @Headers() headers: Record<string, string | undefined>) {
    const integration = await this.integrations.get('gate');
    const secret = integration.secrets.webhookSecret;
    if (!integration.isEnabled || !secret) throw unavailable('Gate readers are not enabled. Turn on the gate integration and set its webhook secret.');
    if (!this.verify(secret, headers, body)) throw new AppError(401, 'UNAUTHORIZED', 'Invalid webhook signature');

    const items = Array.isArray((body as { events?: unknown }).events) ? ((body as { events: unknown[] }).events as Record<string, unknown>[]) : [body];
    if (items.length > 500) throw new AppError(413, 'TOO_LARGE', 'Send at most 500 scans per request');
    const { gates } = await this.ctx.gates();
    const clock = await this.ctx.clock();
    const defaultMethod = integration.provider === 'Hikvision' ? 'Face' : 'RFID';
    let accepted = 0;
    let duplicates = 0;
    const unknown: string[] = [];
    const results: { ref: string; status: 'accepted' | 'duplicate' | 'unknown_student'; direction?: string; notified?: boolean }[] = [];

    for (const raw of items) {
      const item = raw && typeof raw === 'object' ? raw : {};
      const str = (k: string) => (typeof item[k] === 'string' || typeof item[k] === 'number' ? String(item[k]).trim() : '');
      const ref = str('studentId') || str('admissionNo') || str('cardNo') || str('personId') || str('userId');
      const student = ref ? await this.findStudent(ref) : null;
      if (!student) {
        unknown.push(ref || '(missing id)');
        results.push({ ref, status: 'unknown_student' });
        continue;
      }
      let occurredAt = str('occurredAt') ? new Date(str('occurredAt')) : new Date();
      if (Number.isNaN(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 5 * 60_000) occurredAt = new Date();
      const dirRaw = str('direction').toLowerCase();
      let direction: 'in' | 'out' | null = ['in', 'entry', 'enter', 'checkin'].includes(dirRaw) ? 'in' : ['out', 'exit', 'leave', 'checkout'].includes(dirRaw) ? 'out' : null;
      if (!direction) {
        const last = await this.prisma.safetyGateEvent.findFirst({
          where: { studentId: student, day: clock.dayValue(clock.date(occurredAt)), occurredAt: { lte: occurredAt } },
          orderBy: { occurredAt: 'desc' },
        });
        direction = last?.direction === 'in' ? 'out' : 'in';
      }
      const gateRaw = str('gate');
      const gate = gates.find((g) => g.toLowerCase() === gateRaw.toLowerCase()) ?? (gateRaw ? gates.find((g) => g.toLowerCase().startsWith(gateRaw.toLowerCase())) : undefined) ?? gates[0] ?? 'Main Gate';
      const method = METHOD_ALIASES[str('method').toLowerCase()] ?? defaultMethod;
      const r = await this.gate.record({ studentId: student, direction, gate, method, occurredAt, source: 'reader', deviceId: str('deviceId') || null });
      if (r.duplicate) duplicates++;
      else accepted++;
      results.push({ ref, status: r.duplicate ? 'duplicate' : 'accepted', direction, notified: r.notified });
    }
    return { accepted, duplicates, unknown, results };
  }

  private verify(secret: string, headers: Record<string, string | undefined>, body: unknown): boolean {
    const same = (a: string, b: string) => {
      const x = Buffer.from(a);
      const y = Buffer.from(b);
      return x.length === y.length && timingSafeEqual(x, y);
    };
    const shared = headers['x-gate-secret'] ?? headers['x-webhook-secret'] ?? (headers.authorization?.startsWith('Bearer ') ? headers.authorization.slice(7) : undefined);
    if (shared && same(shared.trim(), secret)) return true;
    const sig = (headers['x-gate-signature'] ?? headers['x-signature'] ?? headers['x-hub-signature-256'])?.trim().replace(/^sha256=/i, '').toLowerCase();
    if (sig) {
      const expected = createHmac('sha256', secret).update(JSON.stringify(body ?? {})).digest('hex');
      return same(sig, expected);
    }
    return false;
  }

  private async findStudent(ref: string): Promise<string | null> {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
      const s = await this.prisma.student.findFirst({ where: { id: ref, status: 'active' }, select: { id: true } });
      if (s) return s.id;
    }
    const s = await this.prisma.student.findFirst({ where: { admissionNo: { equals: ref, mode: 'insensitive' }, status: 'active' }, select: { id: true } });
    return s?.id ?? null;
  }
}

/** Scoped student search for safety and transport forms (gate and transport staff need no student-register access). */
@Controller('safety')
export class SafetyStudentsController {
  constructor(private readonly ctx: SafetyContext) {}

  @Get('students')
  @RequirePermissions('safety.read', 'safety.manage', 'transport.read', 'transport.manage')
  async students(@Query() q: StudentSearchQuery, @CurrentUser() user: AuthUser) {
    const scope = await this.ctx.studentWhere(user, q.campusId);
    const term = q.q?.trim();
    const where: Prisma.StudentWhereInput = {
      AND: [
        scope,
        { status: 'active' },
        q.routeId ? { transport: { routeId: q.routeId } } : {},
        term ? { OR: [{ fullName: { contains: term, mode: 'insensitive' } }, { admissionNo: { contains: term, mode: 'insensitive' } }] } : {},
      ],
    };
    const rows = await this.ctx.findStudents(where, { take: q.limit ?? 8 });
    return rows.map((s) => ({
      id: s.id,
      admissionNo: s.admissionNo,
      fullName: s.fullName,
      grade: s.grade,
      section: s.section,
      routeId: s.routeId,
      routeCode: s.routeCode,
      stopId: s.stopId,
      stopName: s.stopName,
    }));
  }
}
