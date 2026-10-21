import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { TalentStrength } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { addDays, asDate, byStudent, dayKey, mean, schoolToday, shortDate } from './intel.util';
import { StudentExtrasService, type ActivityRow } from './student-extras.service';
import { ForEachWorkspace } from '../../tenancy/for-each-workspace.decorator';

/**
 * Talent Discovery: strengths derived from what the school already records — subject results,
 * achievements (verified or not), Innovation Lab projects, competition results and activities.
 * Every score keeps the lines of evidence that produced it.
 */
interface SkillDef {
  name: string;
  subjects: RegExp | null;
  achievements: RegExp;
  types: string[];
  projects?: boolean;
  projectLead?: boolean;
  activities: RegExp;
}

export const SKILLS: SkillDef[] = [
  { name: 'Mathematical reasoning', subjects: /math/i, achievements: /math|olympiad|abacus|numer|aptitude|sudoku|chess/i, types: [], activities: /math|abacus|chess|olympiad/i },
  { name: 'Scientific inquiry', subjects: /science|physics|chemistry|biology|\bevs\b|environment/i, achievements: /science|stem|experiment|research|astronomy|eco/i, types: [], activities: /science|eco|astronomy|nature|lab/i },
  { name: 'Language and communication', subjects: /english|tamil|hindi|french|sanskrit|german|language|literature/i, achievements: /debate|elocution|essay|spell|speech|writing|poetry|recitation|\bmun\b|model united|storytell|quiz|journal/i, types: [], activities: /debate|drama|literary|reading|book|journal|mun|quiz|public speaking/i },
  { name: 'Creative arts', subjects: /\bart|music|dance|drama|design|craft/i, achievements: /\bart|music|dance|drama|paint|draw|sing|craft|theatre|design|photograph/i, types: ['Co-curricular'], activities: /art|music|dance|drama|choir|band|craft|theatre|photograph|design/i },
  { name: 'Sports and fitness', subjects: /physical|\bp\.?e\.?\b|sport|games|yoga/i, achievements: /sport|athlet|football|cricket|basketball|chess|swim|tennis|badminton|yoga|kabaddi|race|marathon/i, types: ['Sports'], activities: /sport|football|cricket|basketball|swim|tennis|badminton|athlet|yoga|kabaddi|volley|skating|karate/i },
  { name: 'Innovation and technology', subjects: /computer|\bict\b|coding|robot|technolog|informatics/i, achievements: /robot|cod|hack|tech|\bapp\b|innovat|maker|science fair|ai\b/i, types: ['Innovation'], projects: true, activities: /robot|cod|tech|maker|innovation|electronics|computer/i },
  { name: 'Leadership and service', subjects: null, achievements: /lead|captain|prefect|council|volunteer|service|community|social|head boy|head girl/i, types: ['Service'], projectLead: true, activities: /council|prefect|captain|volunteer|service|community|nss|scout|guide|interact|leader/i },
];

const LEVEL_POINTS: Record<string, number> = { School: 4, District: 6, State: 8, National: 10, International: 12 };
const PROJECT_STAGES = ['Idea', 'Review', 'Mentor', 'Project', 'Prototype', 'Competition', 'Achievement'];
const FRESH_MS = 6 * 60 * 60_000;

export interface TalentRow {
  id: string;
  studentId: string;
  skill: string;
  score: number;
  confidence: string;
  evidence: string[];
  evidenceCount: number;
  activities: number;
  assessedOn: string;
}

@Injectable()
export class TalentService {
  private readonly log = new Logger(TalentService.name);
  private readonly computedAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly extras: StudentExtrasService,
  ) {}

  async threshold(): Promise<number> {
    return Number(await this.settings.get<number>('talent.strong_threshold', 82)) || 82;
  }

  rule(threshold: number) {
    return `Score ${threshold}+ with evidence from at least two kinds of record (results, achievements, projects or activities), and no opportunity offered or decision recorded yet`;
  }

  /** Recomputes the strengths of these students from their records. */
  async recompute(studentIds: string[]): Promise<void> {
    const ids = [...new Set(studentIds)];
    if (!ids.length) return;
    const today = schoolToday();
    const since = asDate(addDays(today, -365));
    const [students, marks, achievements, members, ledProjects, activities] = await Promise.all([
      this.prisma.student.findMany({ where: { id: { in: ids } }, select: { id: true, campusId: true } }),
      this.prisma.assessmentMark.findMany({
        where: { studentId: { in: ids }, isAbsent: false, marks: { not: null }, assessment: { heldOn: { gte: since } } },
        select: { studentId: true, marks: true, assessment: { select: { maxMarks: true, heldOn: true, subjectId: true } } },
      }),
      this.prisma.innovationAchievement.findMany({ where: { studentId: { in: ids } }, orderBy: { achievedOn: 'desc' } }),
      this.prisma.innovationProjectMember.findMany({ where: { studentId: { in: ids } }, select: { studentId: true, role: true, projectId: true } }),
      this.prisma.innovationProject.findMany({ where: { studentId: { in: ids } }, select: { id: true, studentId: true } }),
      this.extras.activities(ids),
    ]);
    const projectIds = [...new Set([...members.map((m) => m.projectId), ...ledProjects.map((p) => p.id)])];
    const projects = projectIds.length
      ? await this.prisma.innovationProject.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, code: true, title: true, stage: true, status: true, updatedAt: true, studentId: true, competitions: { select: { result: true, competition: { select: { name: true, level: true, result: true } } } } },
        })
      : [];
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const subjects = new Map((await this.prisma.subject.findMany({ select: { id: true, name: true, code: true } })).map((s) => [s.id, s]));

    const marksOf = byStudent(marks);
    const achOf = byStudent(achievements);
    const membersOf = byStudent(members);
    const ledOf = byStudent(ledProjects);
    const actsOf = byStudent(activities);
    const rows: Omit<TalentStrength, 'id' | 'computedAt'>[] = [];
    for (const st of students) {
      const myMarks = marksOf(st.id).filter((m) => m.assessment.maxMarks > 0);
      const myAch = achOf(st.id);
      const myProjects = new Map<string, string>(); // projectId → role
      for (const m of membersOf(st.id)) myProjects.set(m.projectId, m.role);
      for (const p of ledOf(st.id)) myProjects.set(p.id, 'Lead');
      const myActs: ActivityRow[] = actsOf(st.id);

      for (const def of SKILLS) {
        const evidence: string[] = [];
        const kinds = new Set<string>();
        const dates: string[] = [];
        let base: number | null = null;
        let points = 0;

        if (def.subjects) {
          const bySubject = new Map<string, { name: string; pcts: number[]; last: string }>();
          for (const m of myMarks) {
            const s = subjects.get(m.assessment.subjectId);
            if (!s || !(def.subjects.test(s.name) || def.subjects.test(s.code))) continue;
            const g = bySubject.get(s.id) ?? { name: s.name, pcts: [], last: '' };
            g.pcts.push((100 * (m.marks ?? 0)) / m.assessment.maxMarks);
            const k = dayKey(m.assessment.heldOn);
            if (k > g.last) g.last = k;
            bySubject.set(s.id, g);
          }
          const all = [...bySubject.values()].flatMap((g) => g.pcts);
          if (all.length >= 2) {
            base = mean(all)!;
            kinds.add('results');
            for (const g of bySubject.values()) {
              evidence.push(`${g.name}: average ${Math.round(mean(g.pcts)!)}% across ${g.pcts.length} assessment${g.pcts.length === 1 ? '' : 's'} (latest ${shortDate(g.last)})`);
              dates.push(g.last);
            }
          }
        }

        let achPoints = 0;
        for (const a of myAch) {
          if (!(def.types.includes(a.type) || def.achievements.test(a.title))) continue;
          const p = LEVEL_POINTS[a.level ?? ''] ?? 4;
          achPoints += a.verified ? p : p / 2;
          kinds.add('achievements');
          const k = dayKey(a.achievedOn);
          dates.push(k);
          evidence.push(`${a.title} — ${a.type}${a.level ? ` · ${a.level}` : ''} (${shortDate(k)} ${k.slice(0, 4)}, ${a.verified ? 'verified' : 'not yet verified'})`);
        }
        points += Math.min(achPoints, 30);

        if (def.projects || def.projectLead) {
          let projPoints = 0;
          for (const [pid, role] of myProjects) {
            const p = projectById.get(pid);
            if (!p) continue;
            const lead = role === 'Lead';
            if (def.projectLead && !def.projects && !lead) continue;
            projPoints += def.projects ? (lead ? 7 : 5) + (p.stage >= 4 ? 2 : 0) : 5;
            const placed = p.competitions.find((c) => /place|winner|gold|silver|bronze|finalist|first|second|third|award/i.test(c.result ?? c.competition.result ?? ''));
            if (def.projects && placed) projPoints += 4;
            kinds.add('projects');
            const k = dayKey(p.updatedAt);
            dates.push(k);
            evidence.push(`Innovation Lab project ${p.code} “${p.title}” (${role}, ${PROJECT_STAGES[p.stage] ?? 'Project'} stage${placed ? ` · ${placed.result ?? placed.competition.result} at ${placed.competition.name}` : ''})`);
          }
          points += Math.min(projPoints, 15);
        }

        let actCount = 0;
        for (const a of myActs) {
          // Innovation Lab projects are counted as projects above.
          if (a.category === 'Innovation' || !def.activities.test(`${a.name} ${a.category}`)) continue;
          actCount++;
          kinds.add('activities');
          if (a.since) dates.push(a.since);
          evidence.push(`${a.name} (${a.role}${a.hours ? `, ${a.hours} h` : ''})`);
        }
        points += Math.min(actCount * 3, 9);

        if (!evidence.length) continue;
        const score = base != null ? Math.min(100, Math.round(base + points * 0.6)) : Math.min(100, Math.round(52 + Math.min(points, 40) * 1.2));
        rows.push(this.row(st.id, st.campusId, def.name, score, evidence, kinds.size, actCount, dates, today));
      }

    }

    // Write only what changed: new strengths in bulk, changed ones updated, vanished ones removed.
    const keep = new Set(rows.map((r) => `${r.studentId}|${r.skill}`));
    const existing = await this.prisma.talentStrength.findMany({ where: { studentId: { in: ids } } });
    const byKey = new Map(existing.map((e) => [`${e.studentId}|${e.skill}`, e]));
    const stale = existing.filter((e) => !keep.has(`${e.studentId}|${e.skill}`)).map((e) => e.id);
    if (stale.length) await this.prisma.talentStrength.deleteMany({ where: { id: { in: stale } } });
    const sig = (r: Omit<TalentStrength, 'id' | 'computedAt'>) => JSON.stringify([r.campusId, r.score, r.confidence, r.evidence, r.evidenceCount, r.activities, dayKey(r.assessedOn)]);
    const create = rows.filter((r) => !byKey.has(`${r.studentId}|${r.skill}`));
    const update = rows.filter((r) => {
      const e = byKey.get(`${r.studentId}|${r.skill}`);
      return e && sig(e) !== sig(r);
    });
    for (let i = 0; i < create.length; i += 1000) await this.prisma.talentStrength.createMany({ data: create.slice(i, i + 1000), skipDuplicates: true });
    for (let i = 0; i < update.length; i += 200) {
      await this.prisma.$transaction(
        update.slice(i, i + 200).map((r) => this.prisma.talentStrength.update({ where: { id: byKey.get(`${r.studentId}|${r.skill}`)!.id }, data: { ...r, computedAt: new Date() } })),
      );
    }
    const now = Date.now();
    for (const id of ids) this.computedAt.set(id, now);
  }

  private row(studentId: string, campusId: string, skill: string, score: number, evidence: string[], kinds: number, activities: number, dates: string[], today: string) {
    const conf = kinds >= 2 && evidence.length >= 3 ? 'High' : evidence.length >= 2 ? 'Medium' : 'Low';
    const latest = dates.filter(Boolean).sort().pop() ?? today;
    return { studentId, campusId, skill, score, confidence: conf, evidence: evidence.slice(0, 12), evidenceCount: kinds, activities, assessedOn: asDate(latest > today ? today : latest) };
  }

  /** Strengths for these students, recomputed when older than six hours. */
  async strengths(studentIds: string[]): Promise<TalentRow[]> {
    const ids = [...new Set(studentIds)];
    if (!ids.length) return [];
    const cutoff = Date.now() - FRESH_MS;
    const stale = ids.filter((id) => (this.computedAt.get(id) ?? 0) < cutoff);
    if (stale.length) {
      try {
        await this.recompute(stale);
      } catch (err) {
        this.log.error(`Talent strengths failed: ${(err as Error).message}`);
      }
    }
    const rows = await this.prisma.talentStrength.findMany({ where: { studentId: { in: ids } }, orderBy: [{ score: 'desc' }, { skill: 'asc' }] });
    return rows.map((r) => ({
      id: r.id, studentId: r.studentId, skill: r.skill, score: r.score, confidence: r.confidence, evidence: r.evidence,
      evidenceCount: r.evidenceCount, activities: r.activities, assessedOn: dayKey(r.assessedOn),
    }));
  }

  /** Nightly refresh for every active student (05:45 school time). */
  @Cron('45 5 * * *', { timeZone: 'Asia/Kolkata', name: 'talent-nightly' })
  @ForEachWorkspace('talent-nightly')
  async nightly() {
    try {
      const ids = (await this.prisma.student.findMany({ where: { status: 'active' }, select: { id: true } })).map((s) => s.id);
      for (let i = 0; i < ids.length; i += 500) await this.recompute(ids.slice(i, i + 500));
    } catch (err) {
      this.log.error(`Nightly talent refresh failed: ${(err as Error).message}`);
    }
  }
}
