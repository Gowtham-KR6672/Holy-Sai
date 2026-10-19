import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { PickupService } from './pickup.service';
import { PICKUP_METHODS, SafetyContext, sortRows } from './safety.util';

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class PickupQuery extends ListQuery {
  @IsOptional() @IsIn(['Pending', 'Verified', 'Revoked']) status?: string;
  @IsOptional() @IsUUID() studentId?: string;
}

class AddPickupDto {
  @IsUUID('all', { message: 'Choose the child' }) studentId: string;
  @IsString() @MinLength(2, { message: 'Enter the full name' }) @MaxLength(120) personName: string;
  @IsString() @MinLength(2, { message: 'Enter the relationship' }) @MaxLength(40) relation: string;
  @IsIn(PICKUP_METHODS, { message: 'Choose a verification method' }) method: string;
  @IsOptional() @IsString() @MaxLength(16) phone?: string;
}

class VerifyDto {
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code' }) code: string;
}

class CollectDto {
  @IsString() @MaxLength(60) gate: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

class UnauthorisedDto {
  @IsUUID('all', { message: 'Choose the child' }) studentId: string;
  @IsString() @MinLength(2, { message: 'Enter the name the person gave' }) @MaxLength(120) personName: string;
  @IsString() @MaxLength(60) gate: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

const STATUS_ORDER: Record<string, number> = { Pending: 0, Verified: 1, Revoked: 2 };

@Controller('pickup')
export class PickupController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: SafetyContext,
    private readonly pickup: PickupService,
  ) {}

  @Get('summary')
  @RequirePermissions('safety.read', 'safety.manage')
  summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    return this.pickup.summary(user, q.campusId);
  }

  @Get('authorisations')
  @RequirePermissions('safety.read', 'safety.manage')
  async list(@Query() q: PickupQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const recordWhere = await this.ctx.recordWhere(user, q.campusId);
    const term = q.q?.trim();
    const where: Prisma.SafetyPickupAuthorisationWhereInput = {
      ...recordWhere,
      ...(q.status ? { status: q.status } : {}),
      ...(q.studentId ? { AND: [{ studentId: q.studentId }] } : {}),
    };
    if (term) {
      const ids = await this.ctx.matchingStudentIds(user, term, q.campusId);
      where.OR = [{ personName: { contains: term, mode: 'insensitive' } }, { relation: { contains: term, mode: 'insensitive' } }, { phone: { contains: term } }, { studentId: { in: ids } }];
    }
    const list = await this.prisma.safetyPickupAuthorisation.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10_000 });
    const rows = await this.pickup.rows(list);
    const sorted = sortRows(rows, q.sort, q.dir, {
      student: (r) => `${r.studentName}|${r.personName}`,
      person: (r) => r.personName,
      status: (r) => STATUS_ORDER[r.status] ?? 9,
      last: (r) => r.lastPickupAt,
      created: (r) => r.createdAt,
    }, 'student');
    return paged(sorted.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  @Post('authorisations')
  @RequirePermissions('safety.manage')
  async add(@Body() dto: AddPickupDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const auth = await this.pickup.add(user, dto, 'office', req);
    const [row] = await this.pickup.rows([auth]);
    return ok(row, `${auth.personName} added — parents asked to confirm`);
  }

  @Post('authorisations/:id/otp')
  @HttpCode(200)
  @RequirePermissions('safety.manage')
  async otp(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.pickup.sendOtp(user, id, req);
    const message = r.devCode && !r.sentTo
      ? 'Code generated — no SMS provider is configured'
      : r.sentTo ? `Code sent to ${r.sentTo} parent contact${r.sentTo === 1 ? '' : 's'}` : 'Code generated — no parent contact could be reached';
    return ok(r, message);
  }

  @Post('authorisations/:id/verify')
  @HttpCode(200)
  @RequirePermissions('safety.manage')
  async verify(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VerifyDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const auth = await this.pickup.verifyOtp(user, id, dto.code, req);
    const [row] = await this.pickup.rows([auth]);
    return ok(row, `${auth.personName} verified`);
  }

  @Post('authorisations/:id/collect')
  @HttpCode(200)
  @RequirePermissions('safety.manage')
  async collect(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CollectDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { event, student, auth } = await this.pickup.collect(user, id, dto, req);
    const [row] = await this.pickup.eventRows([event]);
    return ok(row, `${student.fullName} released to ${auth.personName} — parents notified`);
  }

  @Post('authorisations/:id/revoke')
  @HttpCode(200)
  @RequirePermissions('safety.manage')
  async revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const auth = await this.pickup.revoke(user, id, req);
    const [row] = await this.pickup.rows([auth]);
    return ok(row, `${auth.personName} revoked — parents informed`);
  }

  @Post('unauthorised')
  @HttpCode(200)
  @RequirePermissions('safety.manage')
  async unauthorised(@Body() dto: UnauthorisedDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { incident } = await this.pickup.hold(user, dto, req);
    return ok({ incidentCode: incident.code }, `Collection held — ${incident.code} logged; principal, front office and parents alerted`);
  }
}
