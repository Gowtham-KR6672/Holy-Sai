import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { can, type AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { badRequest, conflict, fieldError, forbidden, notFound } from '../../common/errors';
import { like } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { addDays, DATE_RE, dateOf, day, daysBetween, isRealDate, minutes, nowHm, OpsContext, TIME_RE, today, todayIso } from './ops.util';

const TYPES = ['Classroom', 'Lab', 'Hall', 'Field', 'Library', 'Studio', 'Other'];
const STATUSES = ['Available', 'In use', 'Maintenance', 'Closed'];
/** Utilisation is booked hours against a 40-hour teaching week. */
const WEEK_HOURS = 40;
const OPEN_REQUEST = { notIn: ['Completed', 'Rejected'] };

class FacilityQuery {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() campusId?: string;
}

class FacilityDto {
  @IsUUID('all', { message: 'Choose a campus' }) campusId: string;
  @IsString() @MinLength(1, { message: 'Name is required' }) @MaxLength(120) name: string;
  @IsIn(TYPES, { message: 'Choose a type' }) facilityType: string;
  @IsOptional() @Type(() => Number) @IsInt({ message: 'Enter a capacity of at least 1' }) @Min(1, { message: 'Enter a capacity of at least 1' }) @Max(100000) capacity?: number | null;
  @IsOptional() @IsIn(STATUSES, { message: 'Choose a status' }) status?: string;
}

class BookingQuery {
  @IsOptional() @Matches(DATE_RE) from?: string;
  @IsOptional() @Matches(DATE_RE) to?: string;
}

class BookingDto {
  @Matches(DATE_RE, { message: 'Choose a date' }) bookedOn: string;
  @Matches(TIME_RE, { message: 'Enter a time like 09:00' }) startsAt: string;
  @Matches(TIME_RE, { message: 'Enter a time like 10:00' }) endsAt: string;
  @IsString() @MinLength(3, { message: 'Describe the booking' }) @MaxLength(160) purpose: string;
}

const hours = (b: { startsAt: string; endsAt: string }) => Math.max(0, minutes(b.endsAt) - minutes(b.startsAt)) / 60;

/** Monday–Sunday of the current week on the campus clock. */
function currentWeek() {
  const t = today();
  const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
  const start = addDays(t, -dow);
  return { start, end: addDays(start, 6) };
}

/** Rooms, labs, halls and fields: capacity, status, bookings without clashes, and weekly utilisation. */
@Controller()
@RequirePermissions('operations.read', 'operations.manage')
export class FacilitiesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ctx: OpsContext,
    private readonly audit: AuditService,
  ) {}

  @Get('facilities')
  async list(@Query() q: FacilityQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const where: Prisma.OpsFacilityWhereInput = {
      ...(campusId ? { campusId } : {}),
      ...(q.q?.trim() ? { OR: [{ name: like(q.q) }, { facilityType: like(q.q) }] } : {}),
    };
    const rows = await this.prisma.opsFacility.findMany({ where, orderBy: [{ name: 'asc' }] });
    if (!rows.length) return [];
    const ids = rows.map((f) => f.id);
    const week = currentWeek();
    const t = today();
    const [bookings, requests, campuses] = await Promise.all([
      this.prisma.opsFacilityBooking.findMany({
        where: { facilityId: { in: ids }, cancelledAt: null, bookedOn: { gte: week.start, lte: week.end } },
        orderBy: [{ bookedOn: 'asc' }, { startsAt: 'asc' }],
      }),
      this.prisma.opsMaintenanceRequest.groupBy({ by: ['facilityId'], where: { facilityId: { in: ids }, status: OPEN_REQUEST }, _count: { _all: true } }),
      this.ctx.campusNames(),
    ]);
    const todays = bookings.filter((b) => b.bookedOn.getTime() === t.getTime());
    const now = nowHm();
    const sorted = [...rows].sort((a, b) => (campuses.get(a.campusId) ?? '').localeCompare(campuses.get(b.campusId) ?? '') || a.name.localeCompare(b.name));
    return sorted.map((f) => {
      const mine = bookings.filter((b) => b.facilityId === f.id);
      const bookedHours = Math.round(mine.reduce((s, b) => s + hours(b), 0) * 10) / 10;
      const onToday = todays.filter((b) => b.facilityId === f.id);
      const ongoing = onToday.some((b) => b.startsAt <= now && now < b.endsAt);
      return {
        id: f.id,
        name: f.name,
        facilityType: f.facilityType,
        capacity: f.capacity,
        status: f.status === 'Available' && ongoing ? 'In use' : f.status,
        storedStatus: f.status,
        campusId: f.campusId,
        campusName: campuses.get(f.campusId) ?? '',
        bookedHours,
        utilisation: Math.min(100, Math.round((bookedHours / WEEK_HOURS) * 100)),
        today: onToday.map((b) => ({ id: b.id, purpose: b.purpose, startsAt: b.startsAt, endsAt: b.endsAt })),
        openRequests: requests.find((r) => r.facilityId === f.id)?._count._all ?? 0,
      };
    });
  }

  private async assertUniqueName(campusId: string, name: string, exceptId?: string) {
    const clash = await this.prisma.opsFacility.findFirst({ where: { campusId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw fieldError('name', 'A space with this name already exists on this campus');
  }

  @Post('facilities')
  @RequirePermissions('operations.manage')
  async create(@Body() dto: FacilityDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.ctx.assertCampus(user, dto.campusId);
    const name = dto.name.trim();
    if (!name) throw fieldError('name', 'Name is required');
    await this.assertUniqueName(dto.campusId, name);
    const f = await this.prisma.opsFacility.create({
      data: { campusId: dto.campusId, name, facilityType: dto.facilityType, capacity: dto.capacity ?? null, status: dto.status ?? 'Available' },
    });
    await this.audit.record({ user, action: 'create', module: 'operations', entityType: 'facility', entityId: f.id, campusId: f.campusId, description: `Added space ${f.name} (${f.facilityType})`, req });
    return ok({ id: f.id }, `${f.name} added`);
  }

  @Put('facilities/:id')
  @RequirePermissions('operations.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FacilityDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const existing = await this.prisma.opsFacility.findUnique({ where: { id } });
    if (!existing) throw notFound('Space');
    await this.ctx.assertCampus(user, dto.campusId);
    const name = dto.name.trim();
    if (!name) throw fieldError('name', 'Name is required');
    await this.assertUniqueName(dto.campusId, name, id);
    let status = dto.status ?? existing.status;
    // "In use" is shown automatically while a booking runs; keep a bookable space stored as Available.
    if (status === 'In use' && existing.status === 'Available') {
      const now = nowHm();
      const ongoing = await this.prisma.opsFacilityBooking.count({
        where: { facilityId: id, cancelledAt: null, bookedOn: today(), startsAt: { lte: now }, endsAt: { gt: now } },
      });
      if (ongoing) status = 'Available';
    }
    await this.prisma.opsFacility.update({
      where: { id },
      data: { campusId: dto.campusId, name, facilityType: dto.facilityType, capacity: dto.capacity ?? null, status },
    });
    await this.audit.record({
      user, action: 'update', module: 'operations', entityType: 'facility', entityId: id, campusId: dto.campusId,
      description: `Updated space ${name}${status !== existing.status ? ` (status ${existing.status} → ${status})` : ''}`, req,
    });
    return ok({ id }, `${name} updated`);
  }

  @Get('facilities/:id/bookings')
  async bookings(@Param('id', ParseUUIDPipe) id: string, @Query() q: BookingQuery) {
    const f = await this.prisma.opsFacility.findUnique({ where: { id } });
    if (!f) throw notFound('Space');
    const from = q.from && isRealDate(q.from) ? dateOf(q.from) : today();
    const to = q.to && isRealDate(q.to) ? dateOf(q.to) : addDays(from, 13);
    if (daysBetween(from, to) > 366) throw badRequest('Choose a range of a year or less');
    const rows = await this.prisma.opsFacilityBooking.findMany({
      where: { facilityId: id, cancelledAt: null, bookedOn: { gte: from, lte: to } },
      orderBy: [{ bookedOn: 'asc' }, { startsAt: 'asc' }],
    });
    return {
      facility: { id: f.id, name: f.name, status: f.status },
      bookings: rows.map((b) => ({
        id: b.id, bookedOn: day(b.bookedOn), startsAt: b.startsAt, endsAt: b.endsAt, purpose: b.purpose, bookedBy: b.bookedByName, bookedById: b.bookedById,
      })),
    };
  }

  @Post('facilities/:id/bookings')
  async book(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BookingDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const f = await this.prisma.opsFacility.findUnique({ where: { id } });
    if (!f) throw notFound('Space');
    if (f.status === 'Closed' || f.status === 'Maintenance') throw badRequest(`${f.name} is ${f.status === 'Closed' ? 'closed' : 'under maintenance'} — bookings are blocked`);
    this.scope.campus(user, f.campusId);
    if (!isRealDate(dto.bookedOn)) throw fieldError('bookedOn', 'Choose a date');
    const t = todayIso();
    if (dto.bookedOn < t) throw fieldError('bookedOn', 'Choose today or a later date');
    if (dto.endsAt <= dto.startsAt) throw fieldError('endsAt', 'End must be after start');
    if (dto.bookedOn === t && dto.endsAt <= nowHm()) throw fieldError('startsAt', 'This time has already passed');
    const purpose = dto.purpose.trim();
    if (purpose.length < 3) throw fieldError('purpose', 'Describe the booking');
    const date = dateOf(dto.bookedOn);
    const booking = await this.prisma.$transaction(async (tx) => {
      // Serialise bookings for this space so two requests cannot both pass the clash check.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ops-booking:${id}`}))`;
      const clash = await tx.opsFacilityBooking.findFirst({
        where: { facilityId: id, cancelledAt: null, bookedOn: date, startsAt: { lt: dto.endsAt }, endsAt: { gt: dto.startsAt } },
        orderBy: { startsAt: 'asc' },
      });
      if (clash) throw conflict(`${f.name} is already booked ${clash.startsAt}–${clash.endsAt} for “${clash.purpose}”. Choose another time or space.`);
      return tx.opsFacilityBooking.create({
        data: { facilityId: id, bookedOn: date, startsAt: dto.startsAt, endsAt: dto.endsAt, purpose, bookedById: user.id, bookedByName: user.fullName },
      });
    });
    await this.audit.record({
      user, action: 'create', module: 'operations', entityType: 'facility_booking', entityId: booking.id, campusId: f.campusId,
      description: `Booked ${f.name} on ${dto.bookedOn}, ${dto.startsAt}–${dto.endsAt}: ${purpose}`, req,
    });
    return ok({ id: booking.id }, `${f.name} booked`);
  }

  @Delete('facility-bookings/:id')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const b = await this.prisma.opsFacilityBooking.findUnique({ where: { id }, include: { facility: true } });
    if (!b || b.cancelledAt) throw notFound('Booking');
    if (b.bookedById !== user.id && !can(user, 'operations.manage')) throw forbidden('Only the person who booked it or Operations can cancel this booking');
    await this.prisma.opsFacilityBooking.update({ where: { id }, data: { cancelledAt: new Date(), cancelledById: user.id } });
    await this.audit.record({
      user, action: 'delete', module: 'operations', entityType: 'facility_booking', entityId: id, campusId: b.facility.campusId,
      description: `Cancelled booking of ${b.facility.name} on ${day(b.bookedOn)}, ${b.startsAt}–${b.endsAt} (${b.purpose})`, req,
    });
    return ok({ id }, 'Booking cancelled');
  }
}
