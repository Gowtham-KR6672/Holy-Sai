import { Body, Controller, Get, Injectable, Logger, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { CrmVendor, Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { fieldError, notFound } from '../../common/errors';
import { ListQuery, like, pageOf, sortBy } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AlumniQuery, AlumnusDto, CommQuery, CrmCommunicationDto, PartnerDto, VendorDto, VendorQuery } from './admissions.dto';
import { ENGAGEMENT_RANK, asDate, dateOnly, monthLabel, pct, phoneKey, todayKey } from './admissions.util';
import { LeadsService, assertId } from './leads.service';
import { ForEachWorkspace } from '../../tenancy/for-each-workspace.decorator';

const READ = ['crm.read', 'crm.manage'];
const DAY = 86_400_000;
const RENEWAL_DAYS = 90;

type AlumniOrder = Prisma.CrmAlumnusOrderByWithRelationInput[];
const ALUMNI_SORT: Record<string, (d: 'asc' | 'desc') => AlumniOrder> = {
  name: (d) => [{ fullName: d }],
  university: (d) => [{ university: { sort: d, nulls: 'last' } }],
  engagement: (d) => [{ engagementRank: d }],
  batch: (d) => [{ batchYear: d }],
};

type VendorOrder = Prisma.CrmVendorOrderByWithRelationInput[];
const VENDOR_SORT: Record<string, (d: 'asc' | 'desc') => VendorOrder> = {
  name: (d) => [{ name: d }],
  contractEnd: (d) => [{ contractEnd: { sort: d, nulls: 'last' } }],
  value: (d) => [{ contractValue: d }],
  status: (d) => [{ status: d }],
};

const today = () => asDate(todayKey());
const renewalLimit = () => new Date(today().getTime() + RENEWAL_DAYS * DAY);

/** Contract housekeeping: contracts past their end date expire; managers hear about renewals 90 days ahead. */
@Injectable()
export class VendorRenewals {
  private readonly log = new Logger(VendorRenewals.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async expire() {
    await this.prisma.crmVendor.updateMany({ where: { status: { in: ['Active', 'Renewal due'] }, contractEnd: { lt: today() } }, data: { status: 'Expired' } });
  }

  @Cron('0 30 2 * * *')
  @ForEachWorkspace('crm-vendor-renewals')
  async daily() {
    try {
      await this.expire();
      const due = await this.prisma.crmVendor.findMany({
        where: { status: { in: ['Active', 'Renewal due'] }, contractEnd: { gte: today(), lte: renewalLimit() }, renewalNotifiedAt: null },
      });
      for (const v of due) {
        await this.notifications.notifyPermission('crm.manage', {
          category: 'Attention', topic: 'system', module: 'crm', icon: 'refresh',
          title: `Contract renewal due: ${v.name}`, body: `${v.category} contract ends ${dateOnly(v.contractEnd)}. Review the renewal.`, route: '/vendors?status=Renewal+due',
        });
        await this.prisma.crmVendor.update({ where: { id: v.id }, data: { renewalNotifiedAt: new Date() } });
      }
    } catch (e) {
      this.log.warn(`Vendor renewal check failed: ${(e as Error).message}`);
    }
  }
}

/** Alumni directory, vendors and partners, and the one communication timeline across them all. */
@Controller()
export class CrmController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
    private readonly renewals: VendorRenewals,
  ) {}

  // -------------------------------------------------------------------------
  // Alumni
  // -------------------------------------------------------------------------

  @Get('alumni')
  @RequirePermissions(...READ)
  async alumni(@Query() q: AlumniQuery) {
    const p = pageOf(q);
    const and: Prisma.CrmAlumnusWhereInput[] = [];
    if (q.engagement) and.push({ engagement: q.engagement });
    if (q.batch && /^\d{4}$/.test(q.batch)) and.push({ batchYear: Number(q.batch) });
    if (q.q?.trim()) {
      const t = q.q.trim();
      and.push({ OR: [{ fullName: like(t) }, { university: like(t) }, { career: like(t) }, { email: like(t) }] });
    }
    const where: Prisma.CrmAlumnusWhereInput = and.length ? { AND: and } : {};
    const orderBy = [...sortBy(q.sort, q.dir, ALUMNI_SORT, 'engagement'), { batchYear: 'desc' as const }, { fullName: 'asc' as const }];
    const [rows, total] = await Promise.all([
      this.prisma.crmAlumnus.findMany({ where, orderBy, skip: p.skip, take: p.take }),
      this.prisma.crmAlumnus.count({ where }),
    ]);
    return paged(rows.map((a) => this.alumnusView(a)), total, p);
  }

  @Get('alumni/summary')
  @RequirePermissions(...READ)
  async alumniSummary() {
    const [all, ys] = await Promise.all([
      this.prisma.crmAlumnus.findMany({ select: { batchYear: true, engagement: true, mentoring: true, university: true, phoneKey: true, email: true } }),
      this.leads.yearStart(),
    ]);
    const engaged = all.filter((a) => a.engagement === 'High' || a.engagement === 'Medium').length;
    const latestBatch = all.length ? Math.max(...all.map((a) => a.batchYear)) : null;
    const dest = new Map<string, number>();
    for (const a of all) {
      if (latestBatch == null || a.batchYear < latestBatch - 4 || !a.university?.trim()) continue;
      const k = a.university.trim();
      dest.set(k, (dest.get(k) ?? 0) + 1);
    }
    const batches = new Map<number, number>();
    for (const a of all) batches.set(a.batchYear, (batches.get(a.batchYear) ?? 0) + 1);

    // Referrals this year whose referring parent is also an alumnus (matched by phone or email).
    const keys = [...new Set(all.map((a) => a.phoneKey).filter((k): k is string => !!k && k.length >= 8))];
    const emails = [...new Set(all.map((a) => a.email?.toLowerCase()).filter((e): e is string => !!e))];
    let referrals = 0;
    if (keys.length || emails.length) {
      const guardians = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Guardian"
        WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ANY(${keys}::text[]) OR lower(email) = ANY(${emails}::text[])`;
      if (guardians.length) {
        referrals = await this.prisma.admissionReferral.count({ where: { referrerGuardianId: { in: guardians.map((g) => g.id) }, createdAt: { gte: ys } } });
      }
    }
    return {
      total: all.length,
      engaged,
      engagedPct: pct(engaged, all.length),
      mentoring: all.filter((a) => a.mentoring).length,
      referrals,
      latestBatch,
      destinations: [...dest].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)).slice(0, 8),
      byBatch: [...batches].sort((a, b) => a[0] - b[0]).map(([year, value]) => ({ label: String(year), value })),
    };
  }

  @Post('alumni')
  @RequirePermissions('crm.manage')
  async addAlumnus(@Body() dto: AlumnusDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const a = await this.prisma.crmAlumnus.create({ data: this.alumnusData(dto) });
    await this.audit.record({ user, action: 'create', module: 'crm', entityType: 'alumnus', entityId: a.id, description: `Added alumnus ${a.fullName} (batch of ${a.batchYear})`, req });
    return ok(this.alumnusView(a), 'Alumnus added');
  }

  @Patch('alumni/:id')
  @RequirePermissions('crm.manage')
  async updateAlumnus(@Param('id') id: string, @Body() dto: AlumnusDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertId(id, 'Alumnus');
    const before = await this.prisma.crmAlumnus.findUnique({ where: { id } });
    if (!before) throw notFound('Alumnus');
    const a = await this.prisma.crmAlumnus.update({ where: { id }, data: { ...this.alumnusData(dto), mentoring: dto.mentoring ?? before.mentoring } });
    await this.audit.record({ user, action: 'update', module: 'crm', entityType: 'alumnus', entityId: id, description: `Updated alumnus ${a.fullName}`, req });
    return ok(this.alumnusView(a), 'Alumnus updated');
  }

  // -------------------------------------------------------------------------
  // Vendors
  // -------------------------------------------------------------------------

  @Get('vendors')
  @RequirePermissions(...READ)
  async vendors(@Query() q: VendorQuery) {
    await this.renewals.expire();
    const p = pageOf(q, 10);
    const and: Prisma.CrmVendorWhereInput[] = [];
    if (q.status === 'Renewal due') {
      and.push({ OR: [{ status: 'Renewal due' }, { status: 'Active', contractEnd: { gte: today(), lte: renewalLimit() } }] });
    } else if (q.status) and.push({ status: q.status });
    if (q.q?.trim()) {
      const t = q.q.trim();
      and.push({ OR: [{ name: like(t) }, { category: like(t) }, { contactPerson: like(t) }] });
    }
    const where: Prisma.CrmVendorWhereInput = and.length ? { AND: and } : {};
    const orderBy = [...sortBy(q.sort, q.dir, VENDOR_SORT, 'name'), { name: 'asc' as const }];
    const [rows, total] = await Promise.all([
      this.prisma.crmVendor.findMany({ where, orderBy, skip: p.skip, take: p.take }),
      this.prisma.crmVendor.count({ where }),
    ]);
    return paged(rows.map((v) => this.vendorView(v)), total, p);
  }

  @Get('vendors/summary')
  @RequirePermissions(...READ)
  async vendorSummary() {
    await this.renewals.expire();
    const [total, active, renewalDue, value, partners] = await Promise.all([
      this.prisma.crmVendor.count(),
      this.prisma.crmVendor.count({ where: { status: 'Active' } }),
      this.prisma.crmVendor.count({ where: { OR: [{ status: 'Renewal due' }, { status: 'Active', contractEnd: { gte: today(), lte: renewalLimit() } }] } }),
      this.prisma.crmVendor.aggregate({ where: { status: { in: ['Active', 'Renewal due'] } }, _sum: { contractValue: true } }),
      this.prisma.crmPartner.count({ where: { status: 'Active' } }),
    ]);
    return { total, active, renewalDue, contractValue: Number(value._sum.contractValue ?? 0), partners };
  }

  @Post('vendors')
  @RequirePermissions('crm.manage')
  async addVendor(@Body() dto: VendorDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const v = await this.prisma.crmVendor.create({ data: this.vendorData(dto) });
    await this.audit.record({ user, action: 'create', module: 'crm', entityType: 'vendor', entityId: v.id, description: `Added vendor ${v.name} (${v.category})`, req });
    return ok(this.vendorView(v), 'Vendor added');
  }

  @Patch('vendors/:id')
  @RequirePermissions('crm.manage')
  async updateVendor(@Param('id') id: string, @Body() dto: VendorDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertId(id, 'Vendor');
    const before = await this.prisma.crmVendor.findUnique({ where: { id } });
    if (!before) throw notFound('Vendor');
    const data = this.vendorData(dto);
    const endChanged = dateOnly(before.contractEnd) !== dateOnly(data.contractEnd as Date | null);
    const v = await this.prisma.crmVendor.update({ where: { id }, data: { ...data, ...(endChanged ? { renewalNotifiedAt: null } : {}) } });
    const notes = [before.status !== v.status ? `status ${before.status} → ${v.status}` : null, endChanged ? `contract end ${dateOnly(before.contractEnd) ?? '—'} → ${dateOnly(v.contractEnd) ?? '—'}` : null].filter(Boolean);
    await this.audit.record({ user, action: 'update', module: 'crm', entityType: 'vendor', entityId: id, description: `Updated vendor ${v.name}${notes.length ? `: ${notes.join(', ')}` : ''}`, req });
    return ok(this.vendorView(v), 'Vendor updated');
  }

  // -------------------------------------------------------------------------
  // Partners
  // -------------------------------------------------------------------------

  @Get('partners')
  @RequirePermissions(...READ)
  async partners(@Query() q: ListQuery) {
    const p = pageOf(q, 50);
    const where: Prisma.CrmPartnerWhereInput = q.q?.trim() ? { OR: [{ name: like(q.q.trim()) }, { partnerType: like(q.q.trim()) }, { note: like(q.q.trim()) }] } : {};
    const [rows, total] = await Promise.all([
      this.prisma.crmPartner.findMany({ where, orderBy: [{ status: 'asc' }, { name: 'asc' }], skip: p.skip, take: p.take }),
      this.prisma.crmPartner.count({ where }),
    ]);
    return paged(rows.map((r) => ({ id: r.id, name: r.name, partnerType: r.partnerType, sinceYear: r.sinceYear, status: r.status, note: r.note })), total, p);
  }

  @Post('partners')
  @RequirePermissions('crm.manage')
  async addPartner(@Body() dto: PartnerDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    this.checkYear(dto.sinceYear);
    const r = await this.prisma.crmPartner.create({ data: this.partnerData(dto) });
    await this.audit.record({ user, action: 'create', module: 'crm', entityType: 'partner', entityId: r.id, description: `Added partner ${r.name} (${r.partnerType})`, req });
    return ok({ id: r.id, name: r.name, partnerType: r.partnerType, sinceYear: r.sinceYear, status: r.status, note: r.note }, 'Partner added');
  }

  @Patch('partners/:id')
  @RequirePermissions('crm.manage')
  async updatePartner(@Param('id') id: string, @Body() dto: PartnerDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertId(id, 'Partner');
    if (!(await this.prisma.crmPartner.findUnique({ where: { id }, select: { id: true } }))) throw notFound('Partner');
    this.checkYear(dto.sinceYear);
    const r = await this.prisma.crmPartner.update({ where: { id }, data: this.partnerData(dto) });
    await this.audit.record({ user, action: 'update', module: 'crm', entityType: 'partner', entityId: id, description: `Updated partner ${r.name}`, req });
    return ok({ id: r.id, name: r.name, partnerType: r.partnerType, sinceYear: r.sinceYear, status: r.status, note: r.note }, 'Partner updated');
  }

  // -------------------------------------------------------------------------
  // Communication timeline
  // -------------------------------------------------------------------------

  @Get('crm/communications')
  @RequirePermissions('communication.read')
  async communications(@Query() q: CommQuery) {
    const p = pageOf(q, 10);
    const where: Prisma.CrmCommunicationWhereInput = {
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.q?.trim() ? { OR: [{ counterpart: like(q.q.trim()) }, { subject: like(q.q.trim()) }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.crmCommunication.findMany({ where, include: { lead: { select: { code: true } } }, orderBy: { occurredAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.crmCommunication.count({ where }),
    ]);
    return paged(
      rows.map((c) => ({
        id: c.id,
        channel: c.channel,
        who: c.counterpart,
        subject: c.subject,
        status: c.status,
        recipients: c.recipients,
        occurredAt: c.occurredAt.toISOString(),
        leadCode: c.lead?.code ?? null,
        sentBy: c.automated ? 'Automated' : c.sentByName,
      })),
      total,
      p,
    );
  }

  /** Logs a call, message or note with an alumnus, vendor, partner or parent. */
  @Post('crm/communications')
  @RequirePermissions('crm.manage')
  async logCommunication(@Body() dto: CrmCommunicationDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    let who = dto.who?.trim() || '';
    if (dto.alumnusId) {
      const a = await this.prisma.crmAlumnus.findUnique({ where: { id: dto.alumnusId } });
      if (!a) throw fieldError('alumnusId', 'Choose an alumnus');
      who = a.fullName;
      await this.prisma.crmAlumnus.update({ where: { id: a.id }, data: { lastEngagement: `${dto.subject.trim()} — ${monthLabel(new Date())} ${todayKey().slice(0, 4)}`.slice(0, 160) } });
    } else if (dto.vendorId) {
      const v = await this.prisma.crmVendor.findUnique({ where: { id: dto.vendorId } });
      if (!v) throw fieldError('vendorId', 'Choose a vendor');
      who = v.name;
    } else if (dto.partnerId) {
      const r = await this.prisma.crmPartner.findUnique({ where: { id: dto.partnerId } });
      if (!r) throw fieldError('partnerId', 'Choose a partner');
      who = r.name;
    } else if (dto.guardianId) {
      const g = await this.prisma.guardian.findUnique({ where: { id: dto.guardianId } });
      if (!g) throw fieldError('guardianId', 'Choose a parent');
      who = g.fullName;
    }
    if (!who) throw fieldError('who', 'Say who the communication was with');
    const isNote = dto.channel === 'Note';
    const c = await this.prisma.crmCommunication.create({
      data: {
        counterpart: who, channel: dto.channel, direction: isNote ? 'Internal' : dto.direction ?? 'Outbound', subject: dto.subject.trim(), body: dto.body?.trim() || null,
        status: dto.status?.trim() || (isNote ? 'Internal' : 'Completed'), recipients: dto.recipients ?? 1,
        alumnusId: dto.alumnusId ?? null, vendorId: dto.vendorId ?? null, partnerId: dto.partnerId ?? null, guardianId: dto.guardianId ?? null,
        sentById: user.id, sentByName: user.fullName,
      },
    });
    await this.audit.record({ user, action: 'create', module: 'crm', entityType: 'communication', entityId: c.id, description: `Logged ${dto.channel.toLowerCase()} with ${who}`, req });
    return ok({ id: c.id }, isNote ? 'Note added' : 'Communication logged');
  }

  // -------------------------------------------------------------------------

  private checkYear(year?: number) {
    if (year !== undefined && year > Number(todayKey().slice(0, 4))) throw fieldError('sinceYear', 'Enter a valid year');
  }

  private alumnusData(dto: AlumnusDto) {
    if (dto.batchYear > Number(todayKey().slice(0, 4))) throw fieldError('batchYear', 'Enter a valid batch year');
    const engagement = dto.engagement ?? 'Low';
    return {
      fullName: dto.fullName.trim(),
      batchYear: dto.batchYear,
      university: dto.university?.trim() || null,
      career: dto.career?.trim() || null,
      email: dto.email?.trim().toLowerCase() || null,
      phone: dto.phone?.trim() || null,
      phoneKey: dto.phone ? phoneKey(dto.phone) : null,
      engagement,
      engagementRank: ENGAGEMENT_RANK[engagement] ?? 3,
      lastEngagement: dto.lastEngagement?.trim() || null,
      ...(dto.mentoring !== undefined ? { mentoring: dto.mentoring } : {}),
    };
  }

  private alumnusView(a: Prisma.CrmAlumnusGetPayload<object>) {
    return {
      id: a.id,
      fullName: a.fullName,
      batchYear: a.batchYear,
      university: a.university,
      career: a.career,
      email: a.email,
      phone: a.phone,
      engagement: a.engagement as 'High' | 'Medium' | 'Low',
      lastEngagement: a.lastEngagement,
    };
  }

  private vendorData(dto: VendorDto): Prisma.CrmVendorCreateInput {
    const start = dto.contractStart?.slice(0, 10);
    const end = dto.contractEnd?.slice(0, 10);
    if (start && end && end < start) throw fieldError('contractEnd', 'Contract end must be after the start');
    return {
      name: dto.name.trim(),
      category: dto.category.trim(),
      contactPerson: dto.contactPerson?.trim() || null,
      phone: dto.phone?.trim() || null,
      email: dto.email?.trim().toLowerCase() || null,
      contractStart: start ? asDate(start) : null,
      contractEnd: end ? asDate(end) : null,
      contractValue: dto.contractValue ?? 0,
      status: dto.status ?? 'Active',
    };
  }

  private vendorView(v: CrmVendor) {
    const days = v.contractEnd ? Math.round((v.contractEnd.getTime() - today().getTime()) / DAY) : null;
    return {
      id: v.id,
      name: v.name,
      category: v.category,
      contactPerson: v.contactPerson,
      phone: v.phone,
      email: v.email,
      contractStart: dateOnly(v.contractStart),
      contractEnd: dateOnly(v.contractEnd),
      contractValue: Number(v.contractValue),
      status: v.status,
      daysToExpiry: days,
      renewalSoon: v.status === 'Renewal due' || (v.status === 'Active' && days != null && days >= 0 && days <= RENEWAL_DAYS),
    };
  }

  private partnerData(dto: PartnerDto) {
    return {
      name: dto.name.trim(),
      partnerType: dto.partnerType.trim(),
      sinceYear: dto.sinceYear ?? null,
      status: dto.status ?? 'Active',
      note: dto.note?.trim() || null,
    };
  }
}
