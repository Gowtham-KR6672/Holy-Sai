import { Controller, Get, Query } from '@nestjs/common';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ListQuery } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { InnovationService, PLACED_RE, STAGES, asDate, addDays, dayStr, milestoneStatuses, monthStart, todayStr } from './innovation.util';

/** Skill axes compared on the dashboard radar (Student 360 skill scores). */
const SKILL_AXES = ['Creativity', 'Problem solving', 'Collaboration', 'Communication', 'Critical thinking', 'Persistence'];
/** Competitions held this many days ago or later still show on the dashboard. */
const RECENT_DAYS = 90;

/** Innovation Lab dashboard: KPIs, pipeline, recent projects and competitions, all from real rows. */
@Controller('innovation')
export class InnovationDashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lab: InnovationService,
    private readonly scope: ScopeService,
  ) {}

  @Get('dashboard')
  @RequirePermissions('innovation.read', 'innovation.manage')
  async dashboard(@Query() q: ListQuery, @CurrentUser() user: AuthUser) {
    const today = todayStr();
    const scope = await this.lab.studentScope(user, q.campusId);
    const ideaWhere = this.lab.byStudent(scope);
    const projectWhere = this.lab.projectWhere(user, scope);
    const campusId = this.scope.campus(user, q.campusId);
    const year = await this.lab.yearWindow(today);
    const thisMonth = monthStart(today);
    const lastMonth = monthStart(today, -1);

    const [ideaGroups, ideasThisMonth, ideasLastMonth, ideaStudents, projects, panel, achievements, schoolStudents] = await Promise.all([
      this.prisma.innovationIdea.groupBy({ by: ['status'], where: ideaWhere, _count: { _all: true } }),
      this.prisma.innovationIdea.count({ where: { ...ideaWhere, submittedOn: { gte: asDate(thisMonth) } } }),
      this.prisma.innovationIdea.count({ where: { ...ideaWhere, submittedOn: { gte: asDate(lastMonth), lt: asDate(thisMonth) } } }),
      this.prisma.innovationIdea.findMany({ where: ideaWhere, select: { studentId: true }, distinct: ['studentId'] }),
      this.prisma.innovationProject.findMany({
        where: projectWhere,
        include: {
          milestones: { select: { id: true, sequence: true, title: true, dueOn: true, completedOn: true } },
          members: { select: { studentId: true } },
          competitions: { select: { competitionId: true, result: true, competition: { select: { result: true } } } },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.innovationMentor.findMany({ where: { isActive: true }, select: { employeeId: true } }),
      this.prisma.innovationAchievement.count({ where: { ...ideaWhere, achievedOn: { gte: asDate(year.from), lte: asDate(year.to) } } }),
      this.prisma.student.count({ where: { AND: [await this.scope.studentWhere(user, q.campusId), { status: 'active' }] } }),
    ]);

    // Mentors on the panel (in the campus being viewed) and those mentoring an active project now.
    const panelEmployees = panel.length
      ? await this.prisma.employee.findMany({
        where: { id: { in: panel.map((m) => m.employeeId) }, archivedAt: null, employmentStatus: { not: 'exited' }, ...(campusId ? { campusId } : {}) },
        select: { id: true },
      })
      : [];
    const active = projects.filter((p) => p.status === 'Active');
    const activeMentors = new Set(active.map((p) => p.mentorId).filter(Boolean)).size;

    // Students involved: idea submitters plus every project team member.
    const involved = new Set([...ideaStudents.map((i) => i.studentId), ...projects.flatMap((p) => [p.studentId, ...p.members.map((m) => m.studentId)])]);

    // Competition entries of the projects in view.
    const entries = projects.flatMap((p) => p.competitions);
    const placed = entries.filter((e) => PLACED_RE.test(e.result ?? e.competition.result ?? '')).length;

    let overdue = 0;
    for (const p of active) {
      for (const s of milestoneStatuses(true, p.milestones, today).values()) if (s === 'Overdue') overdue += 1;
    }

    const ideaCount = (s: string) => ideaGroups.find((g) => g.status === s)?._count._all ?? 0;
    const atStage = (stage: number) => projects.filter((p) => p.stage === stage).length;
    const pipeline = STAGES.map((label, stage) => ({
      stage,
      label,
      value:
        stage === 0 ? ideaCount('Submitted') + atStage(0)
          : stage === 1 ? ideaCount('Under Review') + atStage(1)
            : stage === 2 ? ideaCount('Accepted') + atStage(2)
              : atStage(stage),
    }));

    const recent = projects.slice(0, 6);
    const [students, mentors] = await Promise.all([
      this.lab.students(recent.map((p) => p.studentId)),
      this.lab.employees(recent.map((p) => p.mentorId)),
    ]);

    const comps = await this.prisma.innovationCompetition.findMany({
      where: { heldOn: { gte: asDate(addDays(today, -RECENT_DAYS)) } },
      orderBy: { heldOn: 'asc' },
      take: 5,
      include: { _count: { select: { entries: true } } },
    });

    return {
      kpis: {
        ideas: ideaGroups.reduce((a, g) => a + g._count._all, 0),
        ideasThisMonth,
        ideasLastMonth,
        activeProjects: active.length,
        totalProjects: projects.length,
        mentors: panelEmployees.length,
        activeMentors,
        students: involved.size,
        studentsPct: schoolStudents ? Math.round((involved.size / schoolStudents) * 1000) / 10 : 0,
        competitions: new Set(entries.map((e) => e.competitionId)).size,
        competitionEntries: entries.length,
        placed,
        achievements,
        prototypes: projects.filter((p) => p.stage >= 4).length,
        overdueMilestones: overdue,
      },
      pipeline,
      projects: recent.map((p) => {
        const st = students.get(p.studentId);
        return {
          id: p.id,
          code: p.code,
          title: p.title,
          stage: p.stage,
          updatedAt: p.updatedAt.toISOString(),
          mentor: p.mentorId ? (mentors.get(p.mentorId)?.fullName ?? null) : null,
          studentId: p.studentId,
          studentName: st?.fullName ?? 'Unknown student',
          grade: st?.grade ?? null,
          section: st?.section ?? null,
          milestones: p.milestones.length,
          done: p.milestones.filter((m) => m.completedOn).length,
        };
      }),
      competitions: comps.map((c) => ({ id: c.id, name: c.name, level: c.level, heldOn: dayStr(c.heldOn)!, result: c.result, teams: c._count.entries })),
      // No Student 360 skill scores are recorded yet: the axes come back without values so the page shows its "not enough data" state.
      skills: SKILL_AXES.map((skill) => ({ skill, lab: null as number | null, school: null as number | null })),
    };
  }
}

