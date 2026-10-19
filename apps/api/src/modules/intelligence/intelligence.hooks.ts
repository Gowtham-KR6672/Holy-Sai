import { Injectable, OnModuleInit } from '@nestjs/common';
import { can, type AuthUser } from '../../common/auth-user';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { SearchService } from '../search/search.service';
import { StudentsExtensions, type ProfileExtras } from '../students/students.extensions';
import { dayKey, STAGES } from './intel.util';
import { IntelPeople } from './people.service';
import { StudentExtrasService } from './student-extras.service';
import { TalentService } from './talent.service';

/**
 * What this module adds elsewhere: the Student 360 profile (skills, talent, activities, interests,
 * Early Warning interventions and timeline entries) and global search (signal codes, Co-Pilot drafts).
 */
@Injectable()
export class IntelligenceHooks implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly search: SearchService,
    private readonly people: IntelPeople,
    private readonly extras: StudentExtrasService,
    private readonly talent: TalentService,
  ) {}

  onModuleInit() {
    StudentsExtensions.registerProfile((studentId, viewer) => this.profile(studentId, viewer));
    this.search.register((user, q) => this.find(user, q));
    // This module's own thresholds, editable under Settings (created once; existing values are never overwritten).
    void this.prisma.setting
      .createMany({
        data: [
          { key: 'early_warning.fee_overdue_days', value: 60, description: 'Days fees may be overdue before Early Warning raises a family-support signal', isPublic: false },
          { key: 'talent.strong_threshold', value: 82, description: 'Talent Discovery score (0–100) that counts as strong evidence', isPublic: false },
        ],
        skipDuplicates: true,
      })
      .catch(() => undefined);
  }

  async profile(studentId: string, viewer: AuthUser): Promise<ProfileExtras> {
    const staff = !['family', 'self'].includes(viewer.scope);
    const [strengths, activities, interests, decisions] = await Promise.all([
      this.talent.strengths([studentId]),
      this.extras.activities([studentId]),
      this.extras.interests([studentId]),
      this.prisma.talentDecision.findMany({ where: { studentId, action: 'accept' }, orderBy: { decidedAt: 'desc' } }),
    ]);
    const out: ProfileExtras = {
      skills: strengths.map((s) => ({ name: s.skill, value: s.score, confidence: s.confidence, evidence: s.evidence })),
      talent: { strengths: strengths.map((s) => ({ name: s.skill, score: s.score, confidence: s.confidence, evidence: s.evidence })) },
      activities: activities.map((a) => ({ name: a.name, category: a.category, role: a.role, since: a.since ?? '', hours: a.hours, status: a.status })),
      interests: [...new Set(interests.map((i) => i.name))],
      timeline: decisions.map((d) => ({ date: dayKey(d.decidedAt), title: `Opportunity offered: ${d.skill}`, body: d.note, category: 'opportunity', tone: 'amber' })),
    };
    // Competition entries of the student's Innovation Lab projects.
    const projectIds = [
      ...(await this.prisma.innovationProjectMember.findMany({ where: { studentId }, select: { projectId: true } })).map((m) => m.projectId),
      ...(await this.prisma.innovationProject.findMany({ where: { studentId }, select: { id: true } })).map((p) => p.id),
    ];
    if (projectIds.length) {
      const entries = await this.prisma.innovationCompetitionEntry.findMany({
        where: { projectId: { in: [...new Set(projectIds)] } },
        select: { result: true, project: { select: { code: true, title: true } }, competition: { select: { name: true, level: true, heldOn: true, result: true } } },
      });
      for (const e of entries) {
        out.timeline!.push({
          date: dayKey(e.competition.heldOn), title: `Competition: ${e.competition.name}`,
          body: `${e.project.code} ${e.project.title} · ${e.competition.level}${e.result ?? e.competition.result ? ` · ${e.result ?? e.competition.result}` : ''}`, category: 'competition', tone: 'info',
        });
      }
    }
    // Interventions only for staff who may see Early Warning (the page shows the tab when the list is present).
    if (staff && can(viewer, 'earlywarning.read', 'earlywarning.manage')) {
      const signals = await this.prisma.earlyWarningSignal.findMany({ where: { studentId }, orderBy: { raisedOn: 'desc' } });
      const owners = await this.people.employeeNames(signals.map((s) => s.ownerId));
      out.interventions = signals.map((s) => ({
        id: s.id, code: s.code, signal: s.signal, signalType: s.signalType, stage: s.stage, opened: dayKey(s.raisedOn), action: s.actionPlan,
        next: s.nextReviewOn ? dayKey(s.nextReviewOn) : null, decision: s.decision, closedAt: s.closedAt?.toISOString() ?? null, owner: s.ownerId ? owners.get(s.ownerId) ?? null : null,
      }));
      for (const s of signals.filter((x) => x.decision === 'accepted')) {
        out.timeline!.push({ date: dayKey(s.reviewedAt ?? s.raisedOn), title: `Support plan opened (${s.code})`, body: s.actionPlan, category: 'intervention', tone: 'amber' });
        if (s.closedAt) out.timeline!.push({ date: dayKey(s.closedAt), title: `Support plan closed (${s.code}) · ${STAGES[5]}`, body: s.outcome, category: 'intervention', tone: 'teal' });
      }
    }
    return out;
  }

  private async find(user: AuthUser, q: string) {
    const hits: { group: string; label: string; meta: string; icon: string; route: string }[] = [];
    if (can(user, 'earlywarning.read', 'earlywarning.manage') && /^ew-?\d+$/i.test(q.trim())) {
      const code = q.trim().toUpperCase().replace(/^EW-?/, 'EW-');
      const s = await this.prisma.earlyWarningSignal.findUnique({ where: { code } });
      if (s) {
        try {
          await this.scope.assertStudent(user, s.studentId);
          const st = await this.prisma.student.findUnique({ where: { id: s.studentId }, select: { fullName: true } });
          hits.push({ group: 'Early Warning', label: `${s.code} · ${st?.fullName ?? ''}`, meta: `${s.signalType} · ${s.closedAt ? 'Closed' : s.decision ?? 'Awaiting review'}`, icon: 'alert', route: '/early-warning' });
        } catch {
          /* outside scope */
        }
      }
    }
    if (can(user, 'ai.use')) {
      const drafts = await this.prisma.copilotDraft.findMany({ where: { requestedById: user.id, title: { contains: q, mode: 'insensitive' } }, take: 3, orderBy: { createdAt: 'desc' } });
      hits.push(...drafts.map((d) => ({ group: 'Co-Pilot drafts', label: d.title, meta: d.status === 'Rejected' ? 'Discarded' : d.status, icon: 'sparkle', route: '/copilot' })));
    }
    return hits;
  }
}
