import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { type AuthUser, can } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { badRequest, forbidden, notFound, unavailable } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaymentGatewayService } from '../finance/payment-gateway.service';
import { CircularsService } from '../parents/circulars.service';
import { EventsService } from '../parents/events.service';
import { PtmService } from '../parents/ptm.service';
import { ThreadsService } from '../parents/threads.service';
import { PickupService } from '../safety/pickup.service';
import { LocationService } from '../transport/location.service';
import { FamilyBookDto, FamilyHistoryQuery, FamilyMessageDto, FamilyPayDto, FamilyPickupDto, FamilyPtmQuery } from './dto';
import { FamilyAccess, isUuid } from './family-access.service';
import { FamilyService, TRACK_STAFF } from './family.service';

const PORTAL = 'parent_portal.use';
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/**
 * Parent 360 routes under /parents: the signed-in parent (GET /parents/me) and one child seen through the family
 * (overview, current location, location history). The parent directory's GET /parents/:id steps aside for "me".
 */
@Controller('parents')
export class FamilyParentsController {
  constructor(
    private readonly access: FamilyAccess,
    private readonly family: FamilyService,
    private readonly locations: LocationService,
  ) {}

  @Get('me')
  @RequirePermissions(PORTAL)
  me(@CurrentUser() user: AuthUser) {
    return this.family.me(user);
  }

  @Get(':pid/children/:cid/overview')
  async overview(@Param('pid') pid: string, @Param('cid') cid: string, @CurrentUser() user: AuthUser) {
    const child = await this.access.familyChild(user, pid, cid);
    return this.family.overview(user, child);
  }

  /** Current location (sensitive: every view is written to the audit trail by the tracking service). */
  @Get(':pid/children/:cid/location')
  async location(@Param('pid') pid: string, @Param('cid') cid: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const child = await this.access.familyChild(user, pid, cid, TRACK_STAFF);
    if (child.viewer === 'family') {
      if (!can(user, 'tracking.read_own_children')) throw forbidden('Location sharing is not enabled on your account. Please contact the school office.');
      return this.locations.familyCurrent(cid, user, req);
    }
    await this.locations.assertCanView(user, cid);
    return this.locations.current(cid, user, req);
  }

  /** Location history: parents see the last tracking.parent_history_days days; staff need tracking.history. */
  @Get(':pid/children/:cid/location/history')
  async history(@Param('pid') pid: string, @Param('cid') cid: string, @Query() q: FamilyHistoryQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const child = await this.access.familyChild(user, pid, cid, ['tracking.history']);
    if (child.viewer === 'family') {
      if (!can(user, 'tracking.read_own_children')) throw forbidden('Location sharing is not enabled on your account. Please contact the school office.');
      return this.locations.familyHistory(cid, q, user, req);
    }
    await this.locations.assertCanView(user, cid);
    return this.locations.history(cid, q, user, req);
  }
}

/**
 * The family portal (/family/*): fees and online payment, receipts, pickup persons, the safety card, circulars
 * with acknowledgements, messages to the class teacher, PTM booking and the family calendar.
 * Child routes check that the child is linked to the signed-in parent; staff may read fees, receipts and the
 * safety card for children in their scope with the matching module permission.
 */
@Controller('family')
export class FamilyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: FamilyAccess,
    private readonly family: FamilyService,
    private readonly gateway: PaymentGatewayService,
    private readonly pickup: PickupService,
    private readonly circulars: CircularsService,
    private readonly threads: ThreadsService,
    private readonly ptm: PtmService,
    private readonly events: EventsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Fees
  // ---------------------------------------------------------------------------

  @Get('children/:id/fees')
  @RequirePermissions(PORTAL, 'fees.pay_own', 'finance.read')
  async fees(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.access.readChild(user, id, ['finance.read']);
    return this.family.fees(id);
  }

  /**
   * Pay Now. Online payments go through the school's Razorpay account:
   *  - { checkout: true, amount, method, feeIds } starts a gateway order for a client that opens Razorpay Checkout;
   *  - { orderId, paymentId, signature } confirms it and returns the receipt.
   * Without a connected gateway nothing is recorded and the parent is asked to pay at the school office.
   */
  @Post('children/:id/fees/pay')
  @HttpCode(200)
  @RequirePermissions('fees.pay_own')
  async pay(@Param('id') id: string, @Body() dto: FamilyPayDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    // Dues can still be cleared after a child has left, so any linked child may be paid for.
    const child = await this.access.ownChild(user, id);

    if (dto.orderId || dto.paymentId || dto.signature) {
      if (!dto.orderId || !dto.paymentId || !dto.signature) throw badRequest('The payment confirmation is incomplete. If money was debited, it will be confirmed automatically.');
      const row = await this.prisma.financePayment.findUnique({ where: { gatewayOrderId: dto.orderId }, select: { studentId: true } });
      if (!row || row.studentId !== child.studentId) throw notFound('Payment order');
      const r = await this.gateway.verify({ orderId: dto.orderId, paymentId: dto.paymentId, signature: dto.signature });
      return ok(
        { id: r.id, receiptNo: r.receiptNo ?? '', amount: r.amount, method: r.method, paidAt: r.paidAt, gatewayRef: r.gatewayRef, status: r.status },
        `Payment successful — receipt ${r.receiptNo}`,
      );
    }

    if (!(await this.gateway.isConfigured())) {
      throw unavailable('Online payment is not set up yet. Please pay at the school office — your receipt will appear here.');
    }
    if (!dto.checkout) {
      // Razorpay Checkout has to open in the payer's browser or app before anything is charged.
      throw unavailable('Card and UPI payments open in the school’s secure payment page. Please pay from the Holy Sai parent app, or at the school office.');
    }
    const contact = await this.prisma.user.findUnique({ where: { id: user.id }, select: { email: true, phone: true } });
    const order = await this.gateway.createOrder({
      studentId: child.studentId,
      amount: dto.amount,
      feeIds: dto.feeIds,
      method: dto.method,
      paidBy: { id: user.id, name: user.fullName, email: contact?.email ?? null, phone: contact?.phone ?? null },
    });
    await this.audit.record({
      user, req, action: 'create', module: 'finance', entityType: 'finance_payment', entityId: order.paymentId, campusId: child.campusId,
      description: `Started an online fee payment of ${inr(order.amount)} for ${child.fullName} (${child.admissionNo}) from the parent portal`,
    });
    return ok(order, `Payment of ${inr(order.amount)} started`);
  }

  @Get('receipts/:id')
  @RequirePermissions(PORTAL, 'fees.pay_own', 'finance.read')
  async receipt(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    if (!isUuid(id)) throw notFound('Receipt');
    const p = await this.prisma.financePayment.findUnique({ where: { id }, select: { studentId: true } });
    if (!p) throw notFound('Receipt');
    await this.access.readChild(user, p.studentId, ['finance.read']);
    return this.family.receipt(id);
  }

  // ---------------------------------------------------------------------------
  // Safety and pickup
  // ---------------------------------------------------------------------------

  @Get('children/:id/safety')
  @RequirePermissions(PORTAL, 'safety.read', 'safety.manage', 'transport.read')
  async safety(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.access.readChild(user, id, ['safety.read', 'safety.manage', 'transport.read']);
    return this.family.safety(id);
  }

  /** A parent adds a pickup person; the office verifies them before the first pickup (audited by the safety service). */
  @Post('children/:id/pickup')
  @RequirePermissions(PORTAL)
  async addPickup(@Param('id') id: string, @Body() dto: FamilyPickupDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const child = await this.access.ownChild(user, id, { active: true });
    const a = await this.pickup.addByParent(user, child.studentId, { personName: dto.personName, relation: dto.relation, phone: dto.phone, method: dto.method }, req);
    return ok(this.family.pickupRow(a), 'Request sent to the school office for verification');
  }

  /** confirm = the parent approves a person the school added; revoke = the person may no longer collect the child. */
  @Post('children/:id/pickup/:pid/:action')
  @HttpCode(200)
  @RequirePermissions(PORTAL)
  async pickupAction(@Param('id') id: string, @Param('pid') pid: string, @Param('action') action: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (action !== 'confirm' && action !== 'revoke') throw notFound('Action');
    if (!isUuid(pid)) throw notFound('Authorised person');
    const child = await this.access.ownChild(user, id, { active: action === 'confirm' });
    if (action === 'confirm') {
      const a = await this.pickup.confirmByParent(user, child.studentId, pid, req);
      return ok(this.family.pickupRow(a), 'Pickup person confirmed');
    }
    const a = await this.pickup.revokeByParent(user, child.studentId, pid, req);
    return ok(this.family.pickupRow(a), 'Pickup authorisation revoked');
  }

  // ---------------------------------------------------------------------------
  // Circulars
  // ---------------------------------------------------------------------------

  @Get('circulars')
  @RequirePermissions(PORTAL)
  circularList(@CurrentUser() user: AuthUser) {
    return this.circulars.familyList(user);
  }

  @Post('circulars/:id/acknowledge')
  @HttpCode(200)
  @RequirePermissions(PORTAL)
  async acknowledge(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!isUuid(id)) throw notFound('Circular');
    if (!user.parentId) throw forbidden('Only parent accounts can acknowledge circulars');
    const before = await this.prisma.commCircularRecipient.findUnique({
      where: { circularId_guardianId: { circularId: id, guardianId: user.parentId } },
      select: { acknowledgedAt: true, studentIds: true, circular: { select: { title: true, reference: true, campusId: true } } },
    });
    const r = await this.circulars.acknowledge(user, id);
    if (before && !before.acknowledgedAt) {
      await this.audit.record({
        user, req, action: 'update', module: 'parents', entityType: 'circular', entityId: id, campusId: before.circular.campusId,
        description: `Acknowledged circular ${before.circular.reference} “${before.circular.title}” from the parent portal`,
        metadata: { studentIds: before.studentIds },
      });
    }
    return ok(r, 'Acknowledged — recorded against your child');
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  @Get('messages')
  @RequirePermissions(PORTAL)
  messages(@CurrentUser() user: AuthUser) {
    return this.threads.familyThreads(user);
  }

  @Post('messages')
  @RequirePermissions(PORTAL)
  async send(@Body() dto: FamilyMessageDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const child = await this.access.ownChild(user, dto.studentId, { active: true });
    const t = await this.threads.postFromFamily(user, { studentId: child.studentId, subject: dto.subject, body: dto.body, threadId: dto.threadId });
    await this.audit.record({
      user, req, action: 'create', module: 'parents', entityType: 'comm_thread', entityId: t.id, campusId: child.campusId,
      description: `Parent sent a message about ${child.fullName}: “${t.subject}”`,
    });
    return ok(t, 'Message sent to the class teacher');
  }

  // ---------------------------------------------------------------------------
  // Parent–teacher meetings
  // ---------------------------------------------------------------------------

  @Get('ptm')
  @RequirePermissions(PORTAL)
  async ptmSessions(@Query() q: FamilyPtmQuery, @CurrentUser() user: AuthUser) {
    if (!user.parentId || !q.studentId) return [];
    const child = await this.access.ownChild(user, q.studentId);
    return this.ptm.familySessions(user, child.studentId);
  }

  @Post('ptm/:id/book')
  @HttpCode(200)
  @RequirePermissions(PORTAL)
  async book(@Param('id') id: string, @Body() dto: FamilyBookDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!isUuid(id)) throw notFound('PTM session');
    const child = await this.access.ownChild(user, dto.studentId, { active: true });
    const r = await this.ptm.book(user, id, child.studentId, dto.slotNo);
    await this.audit.record({
      user, req, action: 'create', module: 'parents', entityType: 'ptm_booking', entityId: r.id, campusId: child.campusId,
      description: `Parent booked PTM slot ${r.slotNo} for ${child.fullName}`,
      metadata: { sessionId: id },
    });
    return ok(r, 'PTM slot booked');
  }

  @Post('ptm/bookings/:id/cancel')
  @HttpCode(200)
  @RequirePermissions(PORTAL)
  async cancel(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!isUuid(id)) throw notFound('Booking');
    const r = await this.ptm.cancelFamilyBooking(user, id);
    const b = await this.prisma.ptmBooking.findUnique({ where: { id }, select: { slotNo: true, sessionId: true, session: { select: { campusId: true } } } });
    await this.audit.record({
      user, req, action: 'update', module: 'parents', entityType: 'ptm_booking', entityId: id, campusId: b?.session.campusId ?? null,
      description: `Parent cancelled PTM booking${b ? ` (slot ${b.slotNo})` : ''}`,
      metadata: b ? { sessionId: b.sessionId } : undefined,
    });
    return ok(r, 'Booking cancelled');
  }

  // ---------------------------------------------------------------------------
  // Calendar
  // ---------------------------------------------------------------------------

  @Get('events')
  @RequirePermissions(PORTAL)
  calendar(@CurrentUser() user: AuthUser) {
    return this.events.familyEvents(user);
  }
}
