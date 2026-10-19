import { Body, Controller, Get, Headers, HttpCode, Post, Put, Query, Req, type RawBodyRequest } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, Public, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { AppError, badRequest, fieldError, notFound, unavailable } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { AuditService } from '../audit/audit.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { WorkforceService } from './workforce.service';
import {
  ATTENDANCE_STATUSES, TODAY_STATUSES, addDays, addMonths, dateOf, groupBy, keyOf, minutes, monthShort, monthStartKey, round, sortRows, timeKey,
  todayKey,
} from './workforce.util';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class SummaryQuery {
  @IsOptional() @IsString() campusId?: string;
  @IsOptional() @Matches(DATE, { message: 'Use YYYY-MM-DD' }) date?: string;
}

class AttendanceQuery extends ListQuery {
  @IsOptional() @Matches(DATE, { message: 'Use YYYY-MM-DD' }) date?: string;
  @IsOptional() @IsIn([...TODAY_STATUSES]) status?: string;
  @IsOptional() @IsIn(['teaching', 'non_teaching']) employeeType?: string;
}

class MarkDto {
  @IsUUID('all', { message: 'Choose the employee' }) employeeId: string;
  @IsDateString({}, { message: 'Choose a date' }) date: string;
  @IsIn([...ATTENDANCE_STATUSES], { message: 'Choose a status' }) status: string;
  @IsOptional() @Matches(/^\d{2}:\d{2}$/, { message: 'Use HH:MM' }) checkIn?: string | null;
  @IsOptional() @Matches(/^\d{2}:\d{2}$/, { message: 'Use HH:MM' }) checkOut?: string | null;
}

interface Punch {
  code: string;
  date: string;
  time: string;
  direction: 'in' | 'out' | null;
  device: string | null;
}

const PRESENT = ['Present', 'Late', 'Half Day'];

/** Staff attendance by shift (biometric, app or manual), the register and its summary, and the biometric webhook. */
@Controller('workforce')
export class AttendanceController {
  constructor(
    private readonly wf: WorkforceService,
    private readonly audit: AuditService,
    private readonly integrations: IntegrationsService,
  ) {}

  private get prisma() {
    return this.wf.prisma;
  }

  @Get('attendance/summary')
  @RequirePermissions('hr.read')
  async summary(@Query() q: SummaryQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.wf.campus(user, q.campusId);
    const date = q.date && q.date <= todayKey() ? q.date : todayKey();
    const emps = await this.prisma.employee.findMany({
      where: this.wf.employeeWhere(campusId),
      select: { id: true, department: true, shiftName: true },
    });
    const ids = emps.map((e) => e.id);
    const from30 = addDays(date, -29);
    const monthsFrom = addMonths(date, -2);
    const histFrom = monthsFrom < from30 ? monthsFrom : from30;
    const [marks, history, roster, shifts] = await Promise.all([
      this.wf.dayMarks(ids, date),
      this.prisma.workforceAttendance.findMany({
        where: { employeeId: { in: ids }, date: { gte: dateOf(histFrom), lte: dateOf(date) } },
        select: { employeeId: true, date: true, status: true },
      }),
      this.prisma.workforceRosterEntry.findMany({ where: { employeeId: { in: ids }, date: dateOf(date) }, include: { shift: true } }),
      this.prisma.workforceShift.findMany({ where: { isActive: true }, orderBy: [{ startsAt: 'asc' }, { name: 'asc' }] }),
    ]);
    const counts = { total: emps.length, present: 0, late: 0, halfDay: 0, absent: 0, leave: 0, notMarked: 0 };
    for (const m of marks.values()) {
      if (m.status === 'Present') counts.present++;
      else if (m.status === 'Late') counts.late++;
      else if (m.status === 'Half Day') counts.halfDay++;
      else if (m.status === 'Absent') counts.absent++;
      else if (m.status === 'On Leave') counts.leave++;
      else counts.notMarked++;
    }
    const rate = (rows: { status: string }[]) => {
      const base = rows.filter((r) => r.status !== 'On Leave').length;
      return base ? round((rows.filter((r) => PRESENT.includes(r.status)).length / base) * 100, 1) : null;
    };
    const last30 = history.filter((h) => keyOf(h.date) >= from30);
    const byDate = groupBy(last30, (h) => keyOf(h.date));
    const trend = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, rows]) => ({ date: d, present: rate(rows) }))
      .filter((t): t is { date: string; present: number } => t.present != null);
    const deptOf = new Map(emps.map((e) => [e.id, e.department]));
    const depts = [...new Set(emps.map((e) => e.department))].sort((a, b) => a.localeCompare(b));
    const byDeptRows = groupBy(last30, (h) => deptOf.get(h.employeeId) ?? '');
    const byDepartment = depts.map((d) => ({ label: d, value: rate(byDeptRows.get(d) ?? []) }));
    const months = [0, 1, 2]
      .map((i) => addMonths(date, i - 2))
      .map((m) => ({ label: monthShort(m), value: rate(history.filter((h) => monthStartKey(keyOf(h.date)) === m)) }))
      .filter((m): m is { label: string; value: number } => m.value != null)
      .map((m) => ({ label: m.label, value: Math.round(m.value) }));

    // By shift: the roster line's shift for the day, else the employee's default shift.
    const rosterBy = new Map(roster.map((r) => [r.employeeId, r]));
    const shiftOf = (e: (typeof emps)[number]) => rosterBy.get(e.id)?.shift.name ?? e.shiftName ?? 'No fixed shift';
    const names = [...shifts.map((s) => s.name)];
    for (const e of emps) if (!names.includes(shiftOf(e))) names.push(shiftOf(e));
    const byShift = names
      .map((name) => {
        const members = emps.filter((e) => shiftOf(e) === name);
        const st = (e: (typeof emps)[number]) => marks.get(e.id)?.status ?? 'Not marked';
        const absent = members.filter((e) => ['Absent', 'On Leave'].includes(st(e)) && rosterBy.get(e.id)?.status !== 'Covered').length;
        const uncovered = roster.filter((r) => r.shift.name === name && r.status === 'Cover needed').length;
        return { shift: name, expected: members.length, present: members.filter((e) => PRESENT.includes(st(e))).length, absent, uncovered };
      })
      .filter((s) => s.expected > 0 || shifts.some((x) => x.name === s.shift));
    return { date, counts, trend, byDepartment, byShift, months };
  }

  @Get('attendance')
  @RequirePermissions('hr.read')
  async register(@Query() q: AttendanceQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q, 50);
    const campusId = this.wf.campus(user, q.campusId);
    const date = q.date && q.date <= todayKey() ? q.date : todayKey();
    const emps = await this.prisma.employee.findMany({
      where: this.wf.employeeWhere(campusId, {
        ...(q.employeeType ? { employeeType: q.employeeType } : {}),
        ...(q.q ? { OR: [{ fullName: like(q.q) }, { code: like(q.q) }] } : {}),
      }),
      orderBy: { fullName: 'asc' },
    });
    const ids = emps.map((e) => e.id);
    const [marks, roster] = await Promise.all([
      this.wf.dayMarks(ids, date),
      this.prisma.workforceRosterEntry.findMany({ where: { employeeId: { in: ids }, date: dateOf(date) }, include: { shift: true } }),
    ]);
    const covers = await this.wf.employeesByIds(roster.map((r) => r.coverEmployeeId));
    const rosterBy = new Map(roster.map((r) => [r.employeeId, r]));
    let rows = emps.map((e) => {
      const m = marks.get(e.id);
      const r = rosterBy.get(e.id);
      return {
        id: e.id,
        code: e.code,
        fullName: e.fullName,
        designation: e.designation,
        department: e.department,
        employeeType: e.employeeType,
        shift: r?.shift.name ?? e.shiftName,
        post: r?.post ?? null,
        checkIn: m?.checkIn ?? null,
        checkOut: m?.checkOut ?? null,
        status: m?.status ?? 'Not marked',
        source: m?.source ?? null,
        rosterId: r?.id ?? null,
        rosterStatus: r?.status ?? null,
        coveredBy: r?.coverEmployeeId ? covers.get(r.coverEmployeeId)?.fullName ?? null : null,
      };
    });
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    const keys: Record<string, (r: (typeof rows)[number]) => string | number | null> = {
      name: (r) => r.fullName,
      code: (r) => r.code,
      shift: (r) => r.shift,
      checkIn: (r) => r.checkIn,
      status: (r) => r.status,
      department: (r) => r.department,
    };
    rows = sortRows(rows, keys[q.sort ?? ''] ?? keys.name, q.dir ?? 'asc');
    return paged(rows.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  /** Marks or corrects one employee's attendance for a day (recorded as a manual entry). */
  @Put('attendance')
  @RequirePermissions('hr.manage')
  async mark(@Body() dto: MarkDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const date = dto.date.slice(0, 10);
    if (date > todayKey()) throw fieldError('date', 'Attendance cannot be marked for a future date');
    const e = await this.prisma.employee.findUnique({ where: { id: dto.employeeId } });
    if (!e || e.archivedAt) throw notFound('Employee');
    const campusId = this.wf.campus(user, null);
    if (campusId && e.campusId !== campusId && !user.permissions.has('dashboard.group')) throw notFound('Employee');
    const needsTime = PRESENT.includes(dto.status);
    const checkIn = needsTime ? dto.checkIn || null : null;
    const checkOut = needsTime ? dto.checkOut || null : null;
    if (needsTime && !checkIn) throw fieldError('checkIn', 'Check-in time is required');
    if (checkIn && checkOut && (minutes(checkOut) ?? 0) < (minutes(checkIn) ?? 0)) throw fieldError('checkOut', 'Check-out is before check-in');
    const before = await this.prisma.workforceAttendance.findUnique({ where: { employeeId_date: { employeeId: e.id, date: dateOf(date) } } });
    const data = { status: dto.status, checkIn, checkOut, source: 'manual', markedById: user.id, campusId: e.campusId };
    await this.prisma.workforceAttendance.upsert({
      where: { employeeId_date: { employeeId: e.id, date: dateOf(date) } },
      create: { employeeId: e.id, date: dateOf(date), ...data },
      update: data,
    });
    await this.audit.record({
      user, action: before ? 'update' : 'create', module: 'workforce', entityType: 'staff_attendance', entityId: e.id, campusId: e.campusId,
      description: `${before ? `Corrected attendance (${before.status} → ${dto.status})` : `Marked ${dto.status}`} for ${e.fullName} on ${date}${checkIn ? ` · in ${checkIn}` : ''}${checkOut ? ` · out ${checkOut}` : ''}`,
      req,
    });
    return ok({ employeeId: e.id, date, status: dto.status }, `Attendance saved for ${e.fullName}`);
  }

  // ---------------------------------------------------------------------------
  // Biometric webhook
  // ---------------------------------------------------------------------------

  /**
   * Punches from biometric devices. Secured by the "biometric" integration's webhook secret, sent either as
   * `X-Webhook-Secret: <secret>` or as `X-Signature: sha256=<hex HMAC-SHA256 of the JSON body>`.
   * Body: `{ punches: [{ employeeCode, timestamp, direction?, deviceSerial? }] }`, an array of punches, or one punch.
   * `timestamp` is ISO 8601 (with offset) or "YYYY-MM-DD HH:MM[:SS]" in school time.
   */
  @Public()
  @Post('webhooks/biometric')
  @HttpCode(200)
  async biometric(@Body() body: unknown, @Headers() headers: Record<string, string | string[] | undefined>, @Req() req: RawBodyRequest<Request>) {
    const integration = await this.integrations.get('biometric');
    if (!integration.isEnabled) throw unavailable('Biometric attendance is not enabled');
    const secret = integration.secrets.webhookSecret;
    if (!secret) throw unavailable('The biometric webhook secret is not configured');
    if (!this.verify(secret, headers, req)) throw new AppError(401, 'UNAUTHORIZED', 'Invalid webhook signature');

    const raw = Array.isArray(body) ? body : Array.isArray((body as { punches?: unknown })?.punches) ? (body as { punches: unknown[] }).punches : body ? [body] : [];
    if (raw.length > 5000) throw badRequest('Send at most 5000 punches per request');
    const devices = (integration.config.deviceSerials ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const punches: Punch[] = [];
    let skipped = 0;
    for (const item of raw) {
      const pch = this.parsePunch(item);
      if (!pch || (devices.length && pch.device && !devices.includes(pch.device))) {
        skipped++;
        continue;
      }
      punches.push(pch);
    }
    const codes = [...new Set(punches.map((x) => x.code))];
    const emps = await this.prisma.employee.findMany({ where: { code: { in: codes }, archivedAt: null } });
    const byCode = new Map(emps.map((e) => [e.code.toUpperCase(), e]));
    const unknown = codes.filter((c) => !byCode.has(c.toUpperCase()));
    let recorded = 0;
    const groups = groupBy(punches.filter((x) => byCode.has(x.code.toUpperCase())), (x) => `${x.code.toUpperCase()}|${x.date}`);
    for (const [k, list] of groups) {
      const e = byCode.get(k.split('|')[0])!;
      const date = list[0].date;
      list.sort((a, b) => a.time.localeCompare(b.time));
      const ins = list.filter((x) => x.direction !== 'out');
      const outs = list.filter((x) => x.direction === 'out');
      const existing = await this.prisma.workforceAttendance.findUnique({ where: { employeeId_date: { employeeId: e.id, date: dateOf(date) } } });
      let checkIn = existing?.checkIn ?? null;
      let checkOut = existing?.checkOut ?? null;
      const firstIn = ins[0]?.time ?? (!checkIn ? list[0].time : null);
      if (firstIn && (!checkIn || firstIn < checkIn)) checkIn = firstIn;
      const candidates = [...outs.map((x) => x.time), ...ins.slice(1).map((x) => x.time)].filter((t) => !checkIn || t > checkIn);
      const lastOut = candidates.sort().pop();
      if (lastOut && (!checkOut || lastOut > checkOut)) checkOut = lastOut;
      if (!checkIn) continue;
      const arrival = await this.wf.arrivalStatus(e.shiftName, checkIn);
      const keep = existing && (existing.status === 'On Leave' || existing.status === 'Half Day' || existing.source === 'manual');
      const status = keep ? existing!.status : arrival;
      await this.prisma.workforceAttendance.upsert({
        where: { employeeId_date: { employeeId: e.id, date: dateOf(date) } },
        create: { employeeId: e.id, campusId: e.campusId, date: dateOf(date), status, checkIn, checkOut, source: 'biometric' },
        update: { checkIn, checkOut, status, ...(existing?.source === 'manual' ? {} : { source: 'biometric' }) },
      });
      recorded += list.length;
    }
    if (punches.length) {
      await this.audit.record({
        userName: 'Biometric device', action: 'create', module: 'workforce', entityType: 'staff_attendance',
        description: `Recorded ${recorded} biometric punch${recorded === 1 ? '' : 'es'} for ${groups.size} employee-day${groups.size === 1 ? '' : 's'}${unknown.length ? `; ${unknown.length} unknown code(s)` : ''}`,
        metadata: { unknown: unknown.slice(0, 50), skipped }, req,
      });
    }
    return ok({ received: raw.length, recorded, skipped, unknownEmployees: unknown }, `Recorded ${recorded} punch${recorded === 1 ? '' : 'es'}`);
  }

  private verify(secret: string, headers: Record<string, string | string[] | undefined>, req: RawBodyRequest<Request>): boolean {
    const h = (name: string) => {
      const v = headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const same = (a: string, b: string) => {
      const x = Buffer.from(a);
      const y = Buffer.from(b);
      return x.length === y.length && timingSafeEqual(x, y);
    };
    const shared = h('x-webhook-secret') ?? h('x-biometric-secret');
    if (shared) return same(shared.trim(), secret);
    const sig = h('x-signature') ?? h('x-hub-signature-256');
    if (sig) {
      const given = sig.replace(/^sha256=/i, '').trim().toLowerCase();
      // HMAC over the exact bytes received (rawBody is enabled in main.ts); re-serialised JSON as a fallback.
      const payload = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      const expected = createHmac('sha256', secret).update(payload).digest('hex');
      return same(given, expected);
    }
    return false;
  }

  private parsePunch(item: unknown): Punch | null {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const code = String(o.employeeCode ?? o.code ?? o.empCode ?? o.employeeId ?? o.userId ?? '').trim();
    const ts = String(o.timestamp ?? o.time ?? o.punchTime ?? o.at ?? '').trim();
    if (!code || !ts) return null;
    let date: string;
    let time: string;
    const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2}(\.\d+)?)?$/.exec(ts);
    if (local) {
      date = local[1];
      time = local[2];
    } else {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return null;
      date = todayKey(d);
      time = timeKey(d);
    }
    if (date > addDays(todayKey(), 1)) return null;
    const dir = String(o.direction ?? o.type ?? o.inOut ?? '').toLowerCase();
    return {
      code,
      date,
      time,
      direction: /^(in|checkin|check-in|0)$/.test(dir) ? 'in' : /^(out|checkout|check-out|1)$/.test(dir) ? 'out' : null,
      device: o.deviceSerial != null ? String(o.deviceSerial) : o.serial != null ? String(o.serial) : null,
    };
  }
}

