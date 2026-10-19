import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, notFound } from '../../common/errors';
import { ListQuery, like, pageOf, sortBy } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { CampusQuery, ReferralDto, ReferralQuery, RewardDto } from './admissions.dto';
import { change, pct } from './admissions.util';
import { LeadsService, assertId } from './leads.service';

const READ = ['admissions.read', 'admissions.manage'];
const DAY = 86_400_000;

/** Guardians have no stored code; the parent code is derived from the record id. */
export const parentCode = (id: string) => `PAR-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;

type RefOrder = Prisma.AdmissionReferralOrderByWithRelationInput[];
const REF_SORT: Record<string, (d: 'asc' | 'desc') => RefOrder> = {
  created: (d) => [{ createdAt: d }],
  parent: (d) => [{ referrerName: d }],
  referredName: (d) => [{ referredName: d }],
  status: (d) => [{ status: d }],
};

/** Parent referrals: the families current parents recommend, and the recognition owed on enrolment. */
@Controller('referrals')
export class ReferralsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  @Get()
  @RequirePermissions(...READ)
  async list(@Query() q: ReferralQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.scope.campus(user, q.campusId);
    const and: Prisma.AdmissionReferralWhereInput[] = [];
    if (campusId) and.push({ campusId });
    if (q.status) and.push({ status: q.status });
    if (q.rewardStatus) and.push({ rewardStatus: q.rewardStatus });
    if (q.q?.trim()) {
      const t = q.q.trim();
      and.push({ OR: [{ referrerName: like(t) }, { referredName: like(t) }, { lead: { code: like(t) } }, { lead: { parentName: like(t) } }] });
    }
    const where: Prisma.AdmissionReferralWhereInput = and.length ? { AND: and } : {};
    const orderBy = [...sortBy(q.sort, q.dir ?? 'desc', REF_SORT, 'created'), { createdAt: 'desc' as const }];
    const [rows, total] = await Promise.all([
      this.prisma.admissionReferral.findMany({ where, include: { lead: { select: { code: true, stage: true, grade: true } } }, orderBy, skip: p.skip, take: p.take }),
      this.prisma.admissionReferral.count({ where }),
    ]);
    return paged(rows.map((r) => this.view(r)), total, p);
  }

  @Get('summary')
  @RequirePermissions(...READ)
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const base: Prisma.AdmissionReferralWhereInput = campusId ? { campusId } : {};
    const now = Date.now();
    const ys = await this.leads.yearStart();
    const [all, parentBase, referralEnrolments, spend] = await Promise.all([
      this.prisma.admissionReferral.findMany({ where: base, select: { referrerGuardianId: true, referrerName: true, status: true, rewardStatus: true, rewardAmount: true, createdAt: true, creditedAt: true } }),
      this.prisma.guardian.count({ where: { students: { some: { student: { status: 'active', ...(campusId ? { campusId } : {}) } } } } }),
      this.prisma.admissionLead.count({ where: { source: 'Referral', enrolledAt: { gte: ys }, ...(campusId ? { campusId } : {}) } }),
      this.leads.spendBySource(ys, new Date(), campusId),
    ]);
    const year = all.filter((r) => r.createdAt >= ys);
    const converted = year.filter((r) => r.status === 'Enrolled').length;
    const families = new Set(year.map((r) => r.referrerGuardianId)).size;
    const last90 = all.filter((r) => r.createdAt.getTime() >= now - 90 * DAY).length;
    const prev90 = all.filter((r) => r.createdAt.getTime() >= now - 180 * DAY && r.createdAt.getTime() < now - 90 * DAY).length;
    const earned = all.filter((r) => ['Pending', 'Credited'].includes(r.rewardStatus) && (r.creditedAt ?? r.createdAt) >= ys).reduce((n, r) => n + Number(r.rewardAmount), 0);
    const channelCost = earned + (spend.get('Referral') ?? 0);
    const rewardsCredited = all.filter((r) => r.rewardStatus === 'Credited' && r.creditedAt && r.creditedAt >= ys).reduce((n, r) => n + Number(r.rewardAmount), 0);

    // Referring families (all time, busiest first).
    const byFamily = new Map<string, typeof all>();
    for (const r of all) byFamily.set(r.referrerGuardianId, [...(byFamily.get(r.referrerGuardianId) ?? []), r]);
    const top = [...byFamily].sort((a, b) => b[1].length - a[1].length || a[1][0].referrerName.localeCompare(b[1][0].referrerName)).slice(0, 25);
    const children = top.length
      ? await this.prisma.studentGuardian.findMany({
        where: { guardianId: { in: top.map(([id]) => id) }, student: { status: 'active' } },
        select: { guardianId: true, student: { select: { fullName: true } } },
      })
      : [];
    return {
      kpis: {
        total: year.length,
        converted,
        conversion: pct(converted, year.length),
        families,
        parentBase,
        familiesPct: pct(families, parentBase),
        delta: change(last90, prev90),
        cpa: referralEnrolments && channelCost > 0 ? Math.round(channelCost / referralEnrolments) : null,
        rewardsCredited: Math.round(rewardsCredited),
        rewardsPending: all.filter((r) => r.rewardStatus === 'Pending').length,
      },
      families: top.map(([parentId, refs]) => {
        const pending = refs.filter((r) => r.rewardStatus === 'Pending').length;
        const credited = refs.filter((r) => r.rewardStatus === 'Credited');
        const kids = children.filter((c) => c.guardianId === parentId).map((c) => c.student.fullName);
        return {
          parentId,
          parent: refs[0].referrerName,
          child: kids.length ? kids.join(', ') : null,
          referred: refs.length,
          converted: refs.filter((r) => r.status === 'Enrolled').length,
          pending,
          credited: credited.length,
          rewardCredited: Math.round(credited.reduce((n, r) => n + Number(r.rewardAmount), 0)),
          recognition: pending ? 'Pending' : credited.length ? 'Acknowledged' : 'Not yet',
        };
      }),
    };
  }

  /** Parents who can be named as the referrer (search by name, phone, email or PAR- code). */
  @Get('referrers')
  @RequirePermissions('admissions.manage')
  async referrers(@Query() q: ListQuery) {
    const t = q.q?.trim() ?? '';
    if (t.length < 2) return [];
    const code = /^PAR-?([0-9a-f]{2,})$/i.exec(t);
    let where: Prisma.GuardianWhereInput;
    if (code) {
      const ids = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Guardian" WHERE replace(id::text, '-', '') LIKE ${code[1].toLowerCase() + '%'} LIMIT 10`;
      where = { id: { in: ids.map((i) => i.id) } };
    } else {
      const digits = t.replace(/\D/g, '');
      where = { OR: [{ fullName: like(t) }, { email: like(t) }, ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : [])] };
    }
    const rows = await this.prisma.guardian.findMany({
      where,
      include: { students: { where: { student: { status: 'active' } }, include: { student: { select: { fullName: true, section: { select: { name: true, class: { select: { name: true } } } } } } } } },
      orderBy: { fullName: 'asc' },
      take: 10,
    });
    return rows.map((g) => ({
      id: g.id,
      fullName: g.fullName,
      parentCode: parentCode(g.id),
      children: g.students.map((s) => `${s.student.fullName} (${s.student.section.class.name}${s.student.section.name})`).join(', ') || null,
    }));
  }

  @Post()
  @RequirePermissions('admissions.manage')
  async create(@Body() dto: ReferralDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const g = await this.prisma.guardian.findUnique({ where: { id: dto.referrerParentId }, include: { students: { include: { student: { select: { campusId: true, status: true } } } } } });
    if (!g) throw fieldError('referrerParentId', 'Choose the referring parent');
    let lead: { id: string; code: string; campusId: string } | null = null;
    if (dto.createLead) {
      if (!dto.lead) throw fieldError('lead.parentName', 'Enter the parent’s name');
      this.scope.campus(user, dto.lead.campusId);
      lead = await this.leads.createLead(
        {
          campusId: dto.lead.campusId, parentName: dto.lead.parentName, phone: dto.lead.phone, studentName: dto.referredName, grade: dto.lead.gradeApplied,
          source: 'Referral', campaign: 'Parent referral', score: 70, notes: `Referred by ${g.fullName} (${parentCode(g.id)})`,
        },
        user,
        'lead.',
      );
    }
    const campusId = lead?.campusId ?? g.students.find((s) => s.student.status === 'active')?.student.campusId ?? g.students[0]?.student.campusId ?? null;
    const referral = await this.prisma.admissionReferral.create({
      data: {
        referrerGuardianId: g.id, referrerName: g.fullName, referredName: dto.referredName.trim(), leadId: lead?.id ?? null, campusId,
        status: 'Submitted', rewardStatus: 'Not eligible', createdById: user.id,
      },
    });
    await this.audit.record({
      user, action: 'create', module: 'admissions', entityType: 'referral', entityId: referral.id, campusId,
      description: `Recorded referral of ${referral.referredName} by ${g.fullName}${lead ? ` (lead ${lead.code})` : ''}`, req,
    });
    return ok({ id: referral.id, leadCode: lead?.code ?? null }, lead ? `Referral recorded — lead ${lead.code} created` : 'Referral recorded');
  }

  @Patch(':id/reward')
  @RequirePermissions('admissions.manage')
  async reward(@Param('id') id: string, @Body() dto: RewardDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertId(id, 'Referral');
    const r = await this.prisma.admissionReferral.findUnique({ where: { id }, include: { lead: { select: { code: true, stage: true, grade: true } } } });
    if (!r) throw notFound('Referral');
    if (r.campusId) this.scope.campus(user, r.campusId);
    if (r.rewardStatus === dto.rewardStatus) return ok(this.view(r), 'No change');
    if (dto.rewardStatus === 'Credited' && r.status !== 'Enrolled') throw badRequest(`Recognition is credited once ${r.referredName} enrols`);
    if (dto.rewardStatus === 'Pending' && r.status !== 'Enrolled') throw badRequest('Recognition becomes due only when the referred child enrols');
    if (r.rewardStatus === 'Credited') throw badRequest('This recognition has already been credited');
    const amount = Number(r.rewardAmount) || Number(await this.settings.get<number>('admissions.referral_reward', 0)) || 0;
    const updated = await this.prisma.admissionReferral.update({
      where: { id },
      data: dto.rewardStatus === 'Credited'
        ? { rewardStatus: 'Credited', rewardAmount: amount, creditedAt: new Date(), creditedById: user.id, creditedByName: user.fullName }
        : { rewardStatus: dto.rewardStatus },
      include: { lead: { select: { code: true, stage: true, grade: true } } },
    });
    await this.audit.record({
      user, action: dto.rewardStatus === 'Credited' ? 'approve' : 'update', module: 'admissions', entityType: 'referral', entityId: id, campusId: r.campusId,
      description: `Referral recognition for ${r.referrerName} (referred ${r.referredName}): ${r.rewardStatus} → ${dto.rewardStatus}${dto.rewardStatus === 'Credited' ? ` · ₹${amount.toLocaleString('en-IN')}` : ''}`,
      req,
    });
    if (dto.rewardStatus === 'Credited') {
      const parents = await this.prisma.user.findMany({ where: { parentId: r.referrerGuardianId, status: 'active' }, select: { id: true } });
      await this.notifications.notifyUsers(parents.map((p) => p.id), {
        category: 'Completed', topic: 'system', module: 'admissions', icon: 'award',
        title: 'Thank you for your referral', body: `Your recognition for referring ${r.referredName} has been credited.`,
      });
    }
    return ok(this.view(updated), dto.rewardStatus === 'Credited' ? 'Recognition credited' : 'Recognition updated');
  }

  private view(r: Prisma.AdmissionReferralGetPayload<{ include: { lead: { select: { code: true; stage: true; grade: true } } } }>) {
    return {
      id: r.id,
      referredName: r.referredName,
      status: r.status,
      rewardStatus: r.rewardStatus,
      rewardAmount: Number(r.rewardAmount),
      createdAt: r.createdAt.toISOString(),
      parentId: r.referrerGuardianId,
      parentName: r.referrerName,
      enquiryId: r.leadId,
      leadCode: r.lead?.code ?? null,
      stage: r.lead?.stage ?? null,
      grade: r.lead?.grade ?? null,
    };
  }
}
