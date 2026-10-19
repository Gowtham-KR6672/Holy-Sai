import { Body, Controller, Get, Put, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { fieldError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { CampusQuery, SpendDto, SpendQuery } from './admissions.dto';
import {
  APP_LIVE, CLOSED, SOURCES, STAGES, VISIT, asDate, bucketOf, change, dateOnly, dayKey, lastMonths, median, pct, round1, weekStart, whenLabel,
} from './admissions.util';
import { LeadsService } from './leads.service';

const READ = ['admissions.read', 'admissions.manage'];
const DAY = 86_400_000;

/** Funnel steps and the stage index a lead must have reached to count. */
const FUNNEL: [string, number][] = [['Enquiry', 0], ['Qualified', 2], ['Visit', 4], ['Application', 5], ['Assessment', 6], ['Offer', 7], ['Admission', 8]];

interface CohortLead {
  source: string;
  stage: string;
  maxStageIndex: number;
  createdAt: Date;
  enrolledAt: Date | null;
}

/** Admissions dashboard, conversion analytics, counsellor list and marketing spend. */
@Controller('admissions')
export class AdmissionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly scope: ScopeService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get('counsellors')
  @RequirePermissions(...READ)
  async counsellors(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const rows = await this.leads.counsellors(this.scope.campus(user, q.campusId));
    return rows.map(({ campusId: _c, ...r }) => r);
  }

  @Get('dashboard')
  @RequirePermissions(...READ)
  async dashboard(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const base: Prisma.AdmissionLeadWhereInput = campusId ? { campusId } : {};
    const appBase: Prisma.AdmissionApplicationWhereInput = campusId ? { campusId } : {};
    const visitBase: Prisma.AdmissionFollowUpWhereInput = { type: VISIT, ...(campusId ? { lead: { campusId } } : {}) };
    const now = new Date();
    const ys = await this.leads.yearStart();
    const months = lastMonths(12, now);
    const from = new Date(Math.min(ys.getTime(), months[0].start.getTime(), now.getTime() - 60 * DAY));
    const ws = weekStart(now);
    const soonKey = dayKey(new Date(now.getTime() + 7 * DAY));

    const [leads, enrolments, apps, visits, visitsThisWeek, awaitingDocuments, offers, spend, target] = await Promise.all([
      this.prisma.admissionLead.findMany({ where: { ...base, createdAt: { gte: from } }, select: { source: true, stage: true, maxStageIndex: true, createdAt: true, enrolledAt: true } }),
      this.prisma.admissionLead.findMany({ where: { ...base, enrolledAt: { gte: from } }, select: { createdAt: true, enrolledAt: true } }),
      this.prisma.admissionApplication.findMany({ where: { ...appBase, createdAt: { gte: from } }, select: { createdAt: true } }),
      this.prisma.admissionFollowUp.count({ where: { ...visitBase, status: { in: ['Scheduled', 'Completed'] }, scheduledAt: { gte: ys } } }),
      this.prisma.admissionFollowUp.count({ where: { ...visitBase, status: { not: 'Cancelled' }, scheduledAt: { gte: ws, lt: new Date(ws.getTime() + 7 * DAY) } } }),
      this.prisma.admissionApplication.count({ where: { ...appBase, status: { in: APP_LIVE }, documents: { some: { status: { not: 'Verified' } } } } }),
      this.prisma.admissionApplication.findMany({ where: { ...appBase, status: 'Offer Made' }, select: { offerExpiresOn: true } }),
      this.leads.spendBySource(ys, now, campusId),
      this.target(campusId),
    ]);

    const cohort = leads.filter((l) => l.createdAt >= ys);
    const admittedYear = enrolments.filter((e) => e.enrolledAt! >= ys);
    const enquiries = cohort.length;
    const qualified = cohort.filter((l) => l.maxStageIndex >= 2).length;
    const enrolledCohort = cohort.filter((l) => l.stage === 'Enrolled').length;
    const totalSpend = [...spend.values()].reduce((a, b) => a + b, 0);
    const funnel = this.funnel(cohort);
    const t30 = now.getTime() - 30 * DAY;
    const t60 = now.getTime() - 60 * DAY;
    const inRange = (d: Date, a: number, b: number) => d.getTime() >= a && d.getTime() < b;
    const days = admittedYear.map((e) => (e.enrolledAt!.getTime() - e.createdAt.getTime()) / DAY);
    const med = median(days);
    const bySource = new Map<string, number>();
    for (const l of cohort) bySource.set(l.source, (bySource.get(l.source) ?? 0) + 1);

    return {
      kpis: {
        enquiries,
        qualified,
        qualifiedPct: pct(qualified, enquiries),
        visits,
        visitsThisWeek,
        applications: apps.filter((a) => a.createdAt >= ys).length,
        awaitingDocuments,
        offers: offers.length,
        offersExpiring: offers.filter((o) => o.offerExpiresOn && dateOnly(o.offerExpiresOn)! <= soonKey).length,
        admitted: admittedYear.length,
        target,
        conversion: pct(enrolledCohort, enquiries),
        spend: Math.round(totalSpend),
        cpa: totalSpend > 0 && admittedYear.length ? Math.round(totalSpend / admittedYear.length) : null,
        enquiriesDelta: change(leads.filter((l) => inRange(l.createdAt, t30, Infinity)).length, leads.filter((l) => inRange(l.createdAt, t60, t30)).length),
        admittedDelta: change(enrolments.filter((e) => inRange(e.enrolledAt!, t30, Infinity)).length, enrolments.filter((e) => inRange(e.enrolledAt!, t60, t30)).length),
        medianDaysToAdmit: med == null ? null : Math.round(med),
      },
      funnel,
      insights: { ...this.insights(funnel, enquiries), medianDaysToAdmit: med == null ? null : Math.round(med) },
      sources: [...bySource].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
      monthly: this.monthly(months, leads, apps, enrolments),
      attention: await this.attention(campusId, soonKey),
    };
  }

  @Get('conversion')
  @RequirePermissions(...READ)
  async conversion(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const base: Prisma.AdmissionLeadWhereInput = campusId ? { campusId } : {};
    const appBase: Prisma.AdmissionApplicationWhereInput = campusId ? { campusId } : {};
    const now = new Date();
    const ys = await this.leads.yearStart();
    const prevYs = new Date(ys.getTime() - 365 * DAY);
    const months = lastMonths(12, now);
    const from = new Date(Math.min(prevYs.getTime(), months[0].start.getTime()));

    const [all, enrolments, apps, lost, spend] = await Promise.all([
      this.prisma.admissionLead.findMany({
        where: { ...base, createdAt: { gte: from } },
        select: { source: true, stage: true, maxStageIndex: true, createdAt: true, enrolledAt: true, counsellorId: true, counsellorName: true, firstContactAt: true, nextActionAt: true },
      }),
      this.prisma.admissionLead.findMany({ where: { ...base, enrolledAt: { gte: new Date(Math.min(ys.getTime(), months[0].start.getTime())) } }, select: { createdAt: true, enrolledAt: true } }),
      this.prisma.admissionApplication.findMany({ where: { ...appBase, createdAt: { gte: months[0].start } }, select: { createdAt: true } }),
      this.prisma.admissionLead.groupBy({ by: ['lostReason'], where: { ...base, stage: 'Lost', lostAt: { gte: ys } }, _count: { _all: true } }),
      this.leads.spendBySource(ys, now, campusId),
    ]);

    const cohort = all.filter((l) => l.createdAt >= ys);
    const prevCohort = all.filter((l) => l.createdAt >= prevYs && l.createdAt < ys);
    const admittedYear = enrolments.filter((e) => e.enrolledAt! >= ys);
    const enrolledCohort = cohort.filter((l) => l.stage === 'Enrolled').length;
    const conversion = pct(enrolledCohort, cohort.length);
    const totalSpend = [...spend.values()].reduce((a, b) => a + b, 0);
    const med = median(admittedYear.map((e) => (e.enrolledAt!.getTime() - e.createdAt.getTime()) / DAY));

    // Sources
    const sourceNames = [...new Set([...SOURCES, ...cohort.map((l) => l.source)])];
    const sources = sourceNames
      .map((source) => {
        const rows = cohort.filter((l) => l.source === source);
        const enrolled = rows.filter((l) => l.stage === 'Enrolled').length;
        const s = Math.round(spend.get(source) ?? 0);
        return {
          source,
          enquiries: rows.length,
          qualified: rows.filter((l) => l.maxStageIndex >= 2).length,
          applications: rows.filter((l) => l.maxStageIndex >= 5).length,
          enrolled,
          spend: s,
          conversion: pct(enrolled, rows.length),
          cpa: s > 0 && enrolled ? Math.round(s / enrolled) : null,
          costPerLead: s > 0 && rows.length ? Math.round(s / rows.length) : null,
        };
      })
      .filter((s) => s.enquiries > 0 || s.spend > 0)
      .sort((a, b) => b.enquiries - a.enquiries || a.source.localeCompare(b.source));

    // Counsellors
    const staff = await this.leads.employeeNames(cohort.map((l) => l.counsellorId));
    const groups = new Map<string | null, typeof cohort>();
    for (const l of cohort) groups.set(l.counsellorId, [...(groups.get(l.counsellorId) ?? []), l]);
    const counsellors = [...groups]
      .map(([counsellorId, rows]) => {
        const contact = rows.filter((l) => l.firstContactAt).map((l) => (l.firstContactAt!.getTime() - l.createdAt.getTime()) / 3_600_000);
        const enrolled = rows.filter((l) => l.stage === 'Enrolled').length;
        return {
          counsellor: counsellorId ? staff.get(counsellorId) ?? rows[0].counsellorName ?? 'Former staff' : 'Unassigned',
          counsellorId,
          leads: rows.length,
          open: rows.filter((l) => !CLOSED.includes(l.stage)).length,
          qualified: rows.filter((l) => l.maxStageIndex >= 2).length,
          visited: rows.filter((l) => l.maxStageIndex >= 4).length,
          enrolled,
          lost: rows.filter((l) => l.stage === 'Lost').length,
          overdue: rows.filter((l) => !CLOSED.includes(l.stage) && l.nextActionAt && l.nextActionAt < now).length,
          hoursToContact: contact.length ? round1(contact.reduce((a, b) => a + b, 0) / contact.length) : null,
          conversion: pct(enrolled, rows.length),
        };
      })
      .sort((a, b) => (a.counsellorId ? 0 : 1) - (b.counsellorId ? 0 : 1) || b.leads - a.leads || a.counsellor.localeCompare(b.counsellor));

    // Stage conversion
    const reached = (i: number) => cohort.filter((l) => l.maxStageIndex >= i).length;
    const stages = STAGES.slice(0, -1).map((from, i) => {
      const a = reached(i);
      const b = reached(i + 1);
      return { from, to: STAGES[i + 1], pct: pct(b, a), lost: a - b };
    });

    const prevEnrolled = prevCohort.filter((l) => l.stage === 'Enrolled').length;
    return {
      kpis: {
        enquiries: cohort.length,
        admitted: enrolledCohort,
        lost: lost.reduce((n, g) => n + g._count._all, 0),
        conversion,
        conversionDelta: prevCohort.length ? conversion - pct(prevEnrolled, prevCohort.length) : null,
        cpa: totalSpend > 0 && admittedYear.length ? Math.round(totalSpend / admittedYear.length) : null,
        medianDaysToAdmit: med == null ? null : Math.round(med),
        spend: Math.round(totalSpend),
      },
      sources,
      counsellors,
      funnel: this.funnel(cohort),
      stages,
      monthly: this.monthly(months, all, apps, enrolments),
      lostReasons: lost.map((g) => ({ label: g.lostReason ?? 'Not recorded', value: g._count._all })).sort((a, b) => b.value - a.value),
    };
  }

  // -------------------------------------------------------------------------
  // Marketing spend (cost per admission = spend ÷ admissions)
  // -------------------------------------------------------------------------

  @Get('marketing-spend')
  @RequirePermissions(...READ)
  async spend(@Query() q: SpendQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const year = q.year ?? Number(dayKey(new Date()).slice(0, 4));
    const rows = await this.prisma.admissionMarketingSpend.findMany({
      where: { month: { gte: asDate(`${year}-01-01`), lt: asDate(`${year + 1}-01-01`) }, ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}) },
      orderBy: [{ month: 'asc' }, { source: 'asc' }],
    });
    const campuses = await this.leads.campusNames(rows.map((r) => r.campusId));
    return rows.map((r) => ({
      id: r.id,
      campusId: r.campusId,
      campusName: r.campusId ? campuses.get(r.campusId) ?? '' : 'All campuses',
      source: r.source,
      month: dateOnly(r.month)!.slice(0, 7),
      amount: Number(r.amount),
      note: r.note,
    }));
  }

  @Put('marketing-spend')
  @RequirePermissions('admissions.manage')
  async saveSpend(@Body() dto: SpendDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const campusId = dto.campusId ?? null;
    if (campusId && !(await this.prisma.campus.findUnique({ where: { id: campusId }, select: { id: true } }))) throw fieldError('campusId', 'Choose a campus');
    const month = asDate(`${dto.month}-01`);
    const existing = await this.prisma.admissionMarketingSpend.findFirst({ where: { campusId, source: dto.source, month } });
    if (dto.amount === 0 && existing) await this.prisma.admissionMarketingSpend.delete({ where: { id: existing.id } });
    else if (existing) await this.prisma.admissionMarketingSpend.update({ where: { id: existing.id }, data: { amount: dto.amount, note: dto.note?.trim() || null, updatedById: user.id } });
    else if (dto.amount > 0) await this.prisma.admissionMarketingSpend.create({ data: { campusId, source: dto.source, month, amount: dto.amount, note: dto.note?.trim() || null, updatedById: user.id } });
    // Leads created in that month (school time) carry their share as acquisition cost.
    await this.leads.reallocate(dto.source, new Date(month.getTime() + 12 * 3_600_000));
    await this.audit.record({
      user, action: 'update', module: 'admissions', entityType: 'marketing_spend', campusId,
      description: `Marketing spend for ${dto.source}, ${dto.month}: ₹${dto.amount.toLocaleString('en-IN')}`, req,
    });
    return ok({ source: dto.source, month: dto.month, amount: dto.amount, campusId }, 'Marketing spend saved');
  }

  // -------------------------------------------------------------------------

  private async target(campusId: string | undefined) {
    const campusTarget = Number(await this.settings.get<number>('admissions.target', 0)) || 0;
    if (campusId) return campusTarget > 0 ? campusTarget : null;
    const campuses = await this.prisma.campus.count({ where: { isActive: true } });
    const group = Number(await this.settings.get<number>('admissions.group_target', 0)) || 0;
    const t = campuses > 1 && group > 0 ? group : campusTarget;
    return t > 0 ? t : null;
  }

  private funnel(cohort: Pick<CohortLead, 'maxStageIndex'>[]) {
    return FUNNEL.map(([label, idx]) => ({ label, value: cohort.filter((l) => l.maxStageIndex >= idx).length }));
  }

  private insights(funnel: { label: string; value: number }[], enquiries: number) {
    if (enquiries < 5) return { biggestDrop: null, strongest: null };
    const steps = funnel.slice(1).map((s, i) => ({ from: funnel[i].label, to: s.label, prev: funnel[i].value, next: s.value })).filter((s) => s.prev > 0);
    if (!steps.length) return { biggestDrop: null, strongest: null };
    const withPct = steps.map((s) => ({ from: s.from, to: s.to, pct: pct(s.next, s.prev), lost: s.prev - s.next }));
    const drop = withPct.reduce((a, b) => (b.pct < a.pct ? b : a));
    const strong = withPct.reduce((a, b) => (b.pct > a.pct ? b : a));
    return { biggestDrop: drop, strongest: { from: strong.from, to: strong.to, pct: strong.pct } };
  }

  private monthly(
    months: { start: Date; end: Date; label: string }[],
    leads: { createdAt: Date }[],
    apps: { createdAt: Date }[],
    enrolments: { enrolledAt: Date | null }[],
  ) {
    const count = (dates: Date[]) => {
      const out = months.map(() => 0);
      for (const d of dates) {
        const i = bucketOf(months, d);
        if (i >= 0) out[i]++;
      }
      return out;
    };
    return {
      labels: months.map((m) => m.label),
      enquiries: count(leads.map((l) => l.createdAt)),
      applications: count(apps.map((a) => a.createdAt)),
      admissions: count(enrolments.filter((e) => e.enrolledAt).map((e) => e.enrolledAt!)),
    };
  }

  /** Overdue follow-ups, unowned leads, expiring offers and visits without a host. */
  private async attention(campusId: string | undefined, soonKey: string) {
    const base: Prisma.AdmissionLeadWhereInput = { stage: { notIn: CLOSED }, ...(campusId ? { campusId } : {}) };
    const now = new Date();
    const ws = weekStart(now);
    const [overdue, overdueCount, unassigned, noNext, offers, unhosted] = await Promise.all([
      this.prisma.admissionFollowUp.findMany({
        where: { status: 'Scheduled', scheduledAt: { lt: now }, lead: base },
        include: { lead: { select: { code: true, studentName: true, parentName: true } } },
        orderBy: { scheduledAt: 'asc' },
        take: 4,
      }),
      this.prisma.admissionFollowUp.count({ where: { status: 'Scheduled', scheduledAt: { lt: now }, lead: base } }),
      this.prisma.admissionLead.count({ where: { ...base, counsellorId: null } }),
      this.prisma.admissionLead.count({ where: { ...base, nextActionAt: null } }),
      this.prisma.admissionApplication.findMany({ where: { status: 'Offer Made', offerExpiresOn: { lte: asDate(soonKey) }, ...(campusId ? { campusId } : {}) }, select: { id: true } }),
      this.prisma.admissionFollowUp.count({
        where: { type: VISIT, status: 'Scheduled', assignedTo: null, scheduledAt: { gte: now, lt: new Date(ws.getTime() + 14 * DAY) }, ...(campusId ? { lead: { campusId } } : {}) },
      }),
    ]);
    const staff = await this.leads.employeeNames(overdue.map((f) => f.assignedTo));
    const items: { tone: string; icon: string; title: string; meta: string; lead?: string; route?: string }[] = overdue.map((f) => ({
      tone: 'critical',
      icon: f.type === VISIT ? 'mapPin' : 'clock',
      title: `${f.type === VISIT ? 'Campus visit outcome' : f.type} overdue — ${f.lead.studentName} (${f.lead.code})`,
      meta: `${f.lead.code} · ${f.lead.parentName} · due ${whenLabel(f.scheduledAt)} · ${f.assignedTo ? staff.get(f.assignedTo) ?? f.assignedName : 'No one assigned'}`,
      lead: f.lead.code,
    }));
    if (overdueCount > overdue.length) {
      const more = overdueCount - overdue.length;
      items.push({ tone: 'critical', icon: 'alertCircle', title: `${more} more overdue follow-up${more === 1 ? '' : 's'}`, meta: 'Open the leads list filtered to overdue', route: '/leads?overdue=true' });
    }
    if (unassigned) {
      items.push({
        tone: 'warning', icon: 'userCheck', title: `${unassigned} open lead${unassigned === 1 ? '' : 's'} without a counsellor`,
        meta: 'Assign a counsellor so first contact happens within a day', route: '/leads?counsellorId=unassigned',
      });
    }
    if (offers.length) {
      items.push({
        tone: 'warning', icon: 'award', title: `${offers.length} offer${offers.length === 1 ? '' : 's'} expiring within 7 days`,
        meta: 'Follow up with the families before the offers lapse', route: '/applications?status=Offer+Made',
      });
    }
    if (unhosted) {
      items.push({ tone: 'warning', icon: 'mapPin', title: `${unhosted} campus visit${unhosted === 1 ? '' : 's'} without a host`, meta: 'Upcoming visits in the next two weeks', route: '/visits?range=upcoming&unhosted=true' });
    }
    if (noNext) {
      items.push({ tone: 'info', icon: 'calendar', title: `${noNext} open lead${noNext === 1 ? '' : 's'} with no next step`, meta: 'Schedule a follow-up or close the lead', route: '/pipeline' });
    }
    // The page keys items by title.
    const seen = new Set<string>();
    return items.filter((i) => !seen.has(i.title) && !!seen.add(i.title));
  }
}
