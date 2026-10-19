import { Controller, Get, Param, Query } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { asDate, dayKey, pct, schoolToday } from './intel.util';
import { IntelPeople } from './people.service';
import { findStudent } from './student-ref';
import { StudentExtrasService } from './student-extras.service';
import { TalentService } from './talent.service';

const CATEGORIES = [
  { key: 'achievements', label: 'Verified achievements' },
  { key: 'activities', label: 'Activities' },
  { key: 'projects', label: 'Project evidence' },
  { key: 'documents', label: 'Documents' },
] as const;

const docStatus = (d: { status: string; expiresOn: Date | null }) =>
  d.status === 'Verified' && d.expiresOn && d.expiresOn.getTime() < asDate(schoolToday()).getTime() ? 'Expired' : d.status;

/** Student portfolios compiled from verified achievements, activities, project work and documents. */
@Controller('portfolio')
@RequirePermissions('students.read', 'students.read_assigned')
export class PortfolioController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly people: IntelPeople,
    private readonly extras: StudentExtrasService,
    private readonly talent: TalentService,
  ) {}

  @Get('overview')
  async overview(@Query('campusId') campusId: string | undefined, @CurrentUser() user: AuthUser) {
    const where: Prisma.StudentWhereInput = { AND: [await this.scope.studentWhere(user, campusId), { status: 'active' }] };
    const students = await this.prisma.student.findMany({ where, select: { id: true, section: { select: { class: { select: { name: true, gradeLevel: true } } } } } });
    const ids = students.map((s) => s.id);
    if (!ids.length) return { students: 0, complete: 0, categories: CATEGORIES.map((c) => ({ ...c, value: 0 })), byGrade: [] };

    const [achievements, members, led, projectMarks, documents, activities] = await Promise.all([
      this.prisma.innovationAchievement.groupBy({ by: ['studentId'], where: { studentId: { in: ids }, verified: true }, _count: { _all: true } }),
      this.prisma.innovationProjectMember.findMany({ where: { studentId: { in: ids } }, select: { studentId: true, projectId: true } }),
      this.prisma.innovationProject.findMany({ where: { studentId: { in: ids } }, select: { studentId: true, id: true } }),
      this.prisma.assessmentMark.findMany({ where: { studentId: { in: ids }, isAbsent: false, marks: { not: null }, assessment: { assessmentType: 'project' } }, select: { studentId: true, assessmentId: true } }),
      this.prisma.opsDocument.groupBy({ by: ['studentId'], where: { studentId: { in: ids }, status: 'Verified' }, _count: { _all: true } }),
      this.extras.activities(ids),
    ]);
    const count = new Map<string, Record<string, number>>();
    const bump = (id: string | null, key: string, n = 1) => {
      if (!id) return;
      const c = count.get(id) ?? { achievements: 0, activities: 0, projects: 0, documents: 0 };
      c[key] += n;
      count.set(id, c);
    };
    for (const a of achievements) bump(a.studentId, 'achievements', a._count._all);
    const projects = new Map<string, Set<string>>();
    for (const m of [...members, ...led.map((p) => ({ studentId: p.studentId, projectId: p.id })), ...projectMarks.map((m) => ({ studentId: m.studentId, projectId: m.assessmentId }))]) {
      projects.set(m.studentId, (projects.get(m.studentId) ?? new Set()).add(m.projectId));
    }
    for (const [id, set] of projects) bump(id, 'projects', set.size);
    for (const d of documents) bump(d.studentId, 'documents', d._count._all);
    for (const a of activities.filter((x) => !/inactive|left|ended|withdrawn/i.test(x.status))) bump(a.studentId, 'activities');

    const has = (id: string, key: string) => (count.get(id)?.[key] ?? 0) > 0;
    const isComplete = (id: string) => CATEGORIES.every((c) => has(id, c.key));
    const grades = new Map<string, { level: number; ids: string[] }>();
    for (const s of students) {
      const g = grades.get(s.section.class.name) ?? { level: s.section.class.gradeLevel, ids: [] };
      g.ids.push(s.id);
      grades.set(s.section.class.name, g);
    }
    const sum = (list: string[], key: string) => list.reduce((n, id) => n + (count.get(id)?.[key] ?? 0), 0);
    return {
      students: ids.length,
      complete: pct(ids.filter(isComplete).length, ids.length),
      categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label, value: pct(ids.filter((id) => has(id, c.key)).length, ids.length) })),
      byGrade: [...grades.entries()]
        .sort((a, b) => a[1].level - b[1].level || a[0].localeCompare(b[0]))
        .map(([label, g]) => ({
          label, students: g.ids.length, complete: pct(g.ids.filter(isComplete).length, g.ids.length),
          achievements: sum(g.ids, 'achievements'), activities: sum(g.ids, 'activities'), projects: sum(g.ids, 'projects'), documents: sum(g.ids, 'documents'),
        })),
    };
  }

  @Get('students/:id')
  async student(@Param('id') ref: string, @CurrentUser() user: AuthUser) {
    const s = await findStudent(this.prisma, this.scope, user, ref);
    const [achievements, members, led, projectMarks, documents, activities, interests, strengths, decisions] = await Promise.all([
      this.prisma.innovationAchievement.findMany({ where: { studentId: s.id }, orderBy: { achievedOn: 'desc' } }),
      this.prisma.innovationProjectMember.findMany({ where: { studentId: s.id }, select: { projectId: true, role: true } }),
      this.prisma.innovationProject.findMany({ where: { studentId: s.id }, select: { id: true } }),
      this.prisma.assessmentMark.findMany({
        where: { studentId: s.id, isAbsent: false, marks: { not: null }, assessment: { assessmentType: 'project' } },
        select: { marks: true, grade: true, assessment: { select: { id: true, code: true, name: true, heldOn: true, maxMarks: true, status: true } } },
      }),
      this.prisma.opsDocument.findMany({ where: { studentId: s.id }, orderBy: { createdAt: 'desc' } }),
      this.extras.activities([s.id]),
      this.extras.interests([s.id]),
      this.talent.strengths([s.id]),
      this.prisma.talentDecision.findMany({ where: { studentId: s.id, action: 'accept' }, orderBy: { decidedAt: 'desc' } }),
    ]);
    const projectIds = [...new Set([...members.map((m) => m.projectId), ...led.map((p) => p.id)])];
    const projects = projectIds.length
      ? await this.prisma.innovationProject.findMany({ where: { id: { in: projectIds } }, orderBy: { createdAt: 'desc' } })
      : [];
    const mentors = await this.people.employeeNames(projects.map((p) => p.mentorId));
    const role = new Map(members.map((m) => [m.projectId, m.role]));

    const projectRows = [
      ...projects.map((p) => ({
        id: p.id, code: p.code, title: p.title, status: p.status, date: p.startedOn ? dayKey(p.startedOn) : dayKey(p.createdAt), mentor: p.mentorId ? mentors.get(p.mentorId) ?? null : null,
        source: `Innovation Lab${role.get(p.id) || p.studentId === s.id ? ` · ${p.studentId === s.id ? 'Lead' : role.get(p.id)}` : ''}`,
      })),
      ...projectMarks.map((m) => ({
        id: m.assessment.id, code: m.assessment.code, title: m.assessment.name, status: m.assessment.status, date: dayKey(m.assessment.heldOn), mentor: null,
        source: `Project assessment · ${m.grade ?? `${Math.round((100 * (m.marks ?? 0)) / (m.assessment.maxMarks || 1))}%`}`,
      })),
    ];
    const verified = achievements.filter((a) => a.verified);
    const activeActs = activities.filter((a) => !/inactive|left|ended|withdrawn/i.test(a.status));
    const verifiedDocs = documents.filter((d) => d.status === 'Verified');
    const completeness = CATEGORIES.map((c) => ({
      key: c.key,
      label: c.label,
      done: c.key === 'achievements' ? verified.length > 0 : c.key === 'activities' ? activeActs.length > 0 : c.key === 'projects' ? projectRows.length > 0 : verifiedDocs.length > 0,
    }));

    const timeline = [
      ...(s.admittedOn ? [{ date: dayKey(s.admittedOn), title: 'Joined Holy Sai', body: `${s.section.class.name}${s.section.name} · ${s.campus.name}`, category: 'admission', tone: 'info' }] : []),
      ...verified.map((a) => ({ date: dayKey(a.achievedOn), title: a.title, body: `${a.type}${a.level ? ` · ${a.level}` : ''}${a.verifiedByName ? ` · verified by ${a.verifiedByName}` : ''}`, category: 'achievement', tone: 'teal' })),
      ...projects.flatMap((p) => [
        { date: p.startedOn ? dayKey(p.startedOn) : dayKey(p.createdAt), title: `Started project ${p.code}: ${p.title}`, body: p.summary ?? null, category: 'project', tone: 'info' },
        ...(p.completedOn ? [{ date: dayKey(p.completedOn), title: `Completed project ${p.code}: ${p.title}`, body: null, category: 'project', tone: 'teal' }] : []),
      ]),
      ...activeActs.filter((a) => a.since).map((a) => ({ date: a.since!, title: `Joined ${a.name}`, body: `${a.category} · ${a.role}`, category: 'activity', tone: 'amber' })),
      ...decisions.map((d) => ({ date: dayKey(d.decidedAt), title: `Opportunity: ${d.skill}`, body: d.note, category: 'opportunity', tone: 'amber' })),
    ].sort((a, b) => b.date.localeCompare(a.date));

    return {
      student: {
        id: s.id, fullName: s.fullName, admissionNo: s.admissionNo, house: s.house, grade: s.section.class.name, section: s.section.name, campus: s.campus.name,
      },
      completeness,
      achievements: achievements.map((a) => ({ id: a.id, title: a.title, type: a.type, level: a.level, date: dayKey(a.achievedOn), verified: a.verified })),
      activities: activities.map((a) => ({ name: a.name, category: a.category, role: a.role, since: a.since ?? '', hours: a.hours, status: a.status })),
      projects: projectRows,
      documents: documents.map((d) => ({ id: d.id, name: d.name, category: d.category, status: docStatus(d), verifiedAt: d.verifiedAt?.toISOString() ?? null, hasFile: !!d.storageKey })),
      skills: strengths.map((x) => ({ name: x.skill, score: x.score, confidence: x.confidence })),
      interests: [...new Set(interests.map((i) => i.name))],
      timeline,
    };
  }
}
