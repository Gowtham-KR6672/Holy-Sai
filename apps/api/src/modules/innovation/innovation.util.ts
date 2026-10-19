import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { fieldError, forbidden, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService, type NotifyInput } from '../notifications/notifications.service';

export const STAGES = ['Idea', 'Review', 'Mentor', 'Project', 'Prototype', 'Competition', 'Achievement'];
export const ACHIEVEMENT_STAGE = 6;
export const AREAS = ['Robotics & electronics', 'Software & apps', 'Environment & sustainability', 'Health & wellbeing', 'Community & social', 'Other'];
export const MENTOR_CHOICES = ['Yes, please assign one', 'I already have one in mind', 'Not yet'];
export const LEVELS = ['School', 'District', 'State', 'National', 'International'];
export const EVIDENCE_KINDS = ['Photo', 'Video', 'Document', 'Test log', 'Judging sheet', 'Link'];
export const MEMBER_ROLES = ['Member', 'Designer', 'Researcher', 'Builder', 'Presenter'];
export const ACHIEVEMENT_TYPES = ['Academic', 'Attendance', 'Co-curricular', 'Competition', 'Innovation', 'Sports'];
export const IDEA_STATUSES = ['Submitted', 'Under Review', 'Accepted', 'Converted', 'Declined'];
/** A competition result that counts as a placement. */
export const PLACED_RE = /place|finalist|winner|1st|2nd|3rd|medal/i;
/** Days a submitted idea may wait before it is flagged as overdue for review. */
export const REVIEW_DAYS = 7;
const NIL = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// Dates (the school runs on India time; dates travel as YYYY-MM-DD)
// ---------------------------------------------------------------------------
export function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}
export const dayStr = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const asDate = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
export function addDays(s: string, n: number): string {
  const d = asDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Whole days from `from` to `to` (both YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((asDate(to).getTime() - asDate(from).getTime()) / 86_400_000);
}
export function monthStart(s: string, offset = 0): string {
  const [y, m] = s.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Milestone status (derived, never stored)
// ---------------------------------------------------------------------------
export interface MilestoneLite {
  id: string;
  sequence: number;
  title: string;
  dueOn: Date | null;
  completedOn: Date | null;
}

/**
 * Completed when done; Overdue when an active project's milestone is past due; In Progress for the next
 * open milestone of an active project; otherwise Pending.
 */
export function milestoneStatuses(projectActive: boolean, milestones: MilestoneLite[], today: string): Map<string, string> {
  const sorted = [...milestones].sort((a, b) => a.sequence - b.sequence);
  const firstOpen = sorted.find((m) => !m.completedOn);
  const out = new Map<string, string>();
  for (const m of sorted) {
    if (m.completedOn) out.set(m.id, 'Completed');
    else if (projectActive && m.dueOn && dayStr(m.dueOn)! < today) out.set(m.id, 'Overdue');
    else if (projectActive && firstOpen?.id === m.id) out.set(m.id, 'In Progress');
    else out.set(m.id, 'Pending');
  }
  return out;
}

/** Progress figures for a project card or row. */
export function milestoneProgress(projectActive: boolean, milestones: MilestoneLite[], today: string) {
  const statuses = milestoneStatuses(projectActive, milestones, today);
  const sorted = [...milestones].sort((a, b) => a.sequence - b.sequence);
  const next = sorted.find((m) => !m.completedOn) ?? null;
  return {
    milestones: milestones.length,
    done: milestones.filter((m) => m.completedOn).length,
    overdueMilestones: [...statuses.values()].filter((s) => s === 'Overdue').length,
    nextMilestone: next?.title ?? null,
    nextDue: dayStr(next?.dueOn ?? null),
  };
}

/** Sorts rows in memory by an allow-listed key; blanks last. */
export function sortRows<T>(rows: T[], key: string, dir: 'asc' | 'desc', map: Record<string, (r: T) => string | number | null>): T[] {
  const get = map[key];
  if (!get) return rows;
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y), 'en', { sensitivity: 'base', numeric: true }) * sign;
  });
}

/** What a project list row needs from the database. */
export const PROJECT_LIST_INCLUDE = {
  milestones: { select: { id: true, sequence: true, title: true, dueOn: true, completedOn: true } },
  _count: { select: { members: true } },
} satisfies Prisma.InnovationProjectInclude;
export type ProjectListRecord = Prisma.InnovationProjectGetPayload<{ include: typeof PROJECT_LIST_INCLUDE }>;

export interface StudentInfo {
  id: string;
  fullName: string;
  admissionNo: string;
  campusId: string;
  campusName: string;
  grade: string | null;
  section: string | null;
}

export interface EmployeeInfo {
  id: string;
  code: string;
  fullName: string;
  designation: string;
  department: string;
  campusId: string;
}

/** Student-visibility rule for the lab: everything, one campus, or a list of students. */
export type StudentScope = { kind: 'all' } | { kind: 'campus'; campusId: string } | { kind: 'ids'; ids: string[] };

/** Shared lookups, scope rules and notifications for the Innovation Lab controllers. */
@Injectable()
export class InnovationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  // -- ideas ----------------------------------------------------------------
  /** Creates a submitted idea and assigns the review task (due within a week) to the lab managers. */
  async submitIdea(
    dto: { title: string; problem: string; category: string; wantsMentor?: string },
    student: { id: string; campusId: string; fullName: string },
    user: AuthUser,
    source: 'staff' | 'student',
    req: Request,
  ) {
    const today = todayStr();
    const idea = await this.prisma.innovationIdea.create({
      data: {
        title: dto.title.trim(), problem: dto.problem.trim(), category: dto.category, wantsMentor: dto.wantsMentor ?? null, status: 'Submitted',
        studentId: student.id, campusId: student.campusId, submittedOn: asDate(today), submittedById: user.id, source,
      },
    });
    await this.audit.record({
      user, action: 'create', module: 'innovation', entityType: 'innovation_idea', entityId: idea.id,
      description: source === 'student' ? `Submitted idea "${idea.title}"` : `Submitted idea "${idea.title}" for ${student.fullName}`,
      campusId: student.campusId, req,
    });
    await this.notifications.createTaskForPermission('innovation.manage', {
      title: `Review idea "${idea.title}" — ${student.fullName}`, module: 'innovation', dueOn: addDays(today, REVIEW_DAYS), priority: 'Medium',
      status: 'Under Review', route: '/ideas?status=Submitted', entityType: 'innovation_idea', entityId: idea.id,
    }, student.campusId);
    return idea;
  }

  // -- scope ----------------------------------------------------------------
  async studentScope(user: AuthUser, requestedCampus?: string | null): Promise<StudentScope> {
    const where = await this.scope.studentWhere(user, requestedCampus);
    const keys = Object.keys(where);
    if (!keys.length) return { kind: 'all' };
    if (keys.length === 1 && typeof where.campusId === 'string') return { kind: 'campus', campusId: where.campusId };
    const rows = await this.prisma.student.findMany({ where, select: { id: true } });
    return { kind: 'ids', ids: rows.map((r) => r.id) };
  }

  /** Filter for records with `campusId` + `studentId` columns (ideas, achievements). */
  byStudent(s: StudentScope): { campusId?: string; studentId?: { in: string[] } } {
    if (s.kind === 'all') return {};
    if (s.kind === 'campus') return { campusId: s.campusId };
    return { studentId: { in: s.ids.length ? s.ids : [NIL] } };
  }

  /** Projects the user may see: by campus, or (teachers) projects with a student in their classes or that they mentor. */
  projectWhere(user: AuthUser, s: StudentScope): Prisma.InnovationProjectWhereInput {
    if (s.kind === 'all') return {};
    if (s.kind === 'campus') return { campusId: s.campusId };
    const ids = s.ids.length ? s.ids : [NIL];
    const or: Prisma.InnovationProjectWhereInput[] = [{ studentId: { in: ids } }, { members: { some: { studentId: { in: ids } } } }];
    if (user.employeeId) or.push({ mentorId: user.employeeId });
    return { OR: or };
  }

  async assertProject(user: AuthUser, id: string) {
    const project = await this.prisma.innovationProject.findUnique({ where: { id } });
    if (!project) throw notFound('Project');
    const s = await this.studentScope(user);
    const n = await this.prisma.innovationProject.count({ where: { AND: [this.projectWhere(user, s), { id }] } });
    if (!n) throw forbidden('This project is outside your access');
    return project;
  }

  /** A student the user may act on; returns the student's campus. */
  async assertStudent(user: AuthUser, studentId: string, field = 'studentId') {
    const st = await this.prisma.student.findUnique({ where: { id: studentId }, select: { id: true, campusId: true, fullName: true, status: true } });
    if (!st) throw fieldError(field, 'Student not found');
    await this.scope.assertStudent(user, studentId);
    return st;
  }

  /** Students whose name or admission number matches a search term. */
  async matchingStudentIds(q: string): Promise<string[]> {
    const term = q.trim();
    const rows = await this.prisma.student.findMany({
      where: { OR: [{ fullName: { contains: term, mode: 'insensitive' } }, { admissionNo: { contains: term, mode: 'insensitive' } }] },
      select: { id: true },
      take: 2000,
    });
    return rows.map((r) => r.id);
  }

  // -- lookups --------------------------------------------------------------
  async campusNames(): Promise<Map<string, string>> {
    const rows = await this.prisma.campus.findMany({ select: { id: true, name: true } });
    return new Map(rows.map((c) => [c.id, c.name]));
  }

  async students(ids: (string | null | undefined)[]): Promise<Map<string, StudentInfo>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map();
    const [rows, campuses] = await Promise.all([
      this.prisma.student.findMany({
        where: { id: { in: want } },
        select: { id: true, fullName: true, admissionNo: true, campusId: true, section: { select: { name: true, class: { select: { name: true } } } } },
      }),
      this.campusNames(),
    ]);
    return new Map(
      rows.map((s) => [
        s.id,
        {
          id: s.id,
          fullName: s.fullName,
          admissionNo: s.admissionNo,
          campusId: s.campusId,
          campusName: campuses.get(s.campusId) ?? '',
          grade: s.section?.class?.name ?? null,
          section: s.section?.name ?? null,
        },
      ]),
    );
  }

  async employees(ids: (string | null | undefined)[]): Promise<Map<string, EmployeeInfo>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map();
    const rows = await this.prisma.employee.findMany({
      where: { id: { in: want } },
      select: { id: true, code: true, fullName: true, designation: true, department: true, campusId: true },
    });
    return new Map(rows.map((e) => [e.id, { id: e.id, code: e.code, fullName: e.fullName, designation: e.designation, department: e.department, campusId: e.campusId }]));
  }

  /** Throws a field error unless the employee is an active member of the mentor panel (or is `allow`, the current mentor). */
  async assertMentor(mentorId: string, allow?: string | null) {
    const emp = await this.prisma.employee.findUnique({ where: { id: mentorId }, select: { id: true, fullName: true, employmentStatus: true, archivedAt: true } });
    if (!emp) throw fieldError('mentorId', 'Choose a mentor');
    if (mentorId === allow) return emp;
    if (emp.employmentStatus === 'exited' || emp.archivedAt) throw fieldError('mentorId', `${emp.fullName} is no longer on the staff`);
    const panel = await this.prisma.innovationMentor.findUnique({ where: { employeeId: mentorId } });
    if (!panel?.isActive) throw fieldError('mentorId', `${emp.fullName} is not on the mentor panel`);
    return emp;
  }

  /** Current academic year window, or the calendar year when no year is set up. */
  async yearWindow(today = todayStr()): Promise<{ from: string; to: string; prevFrom: string; prevTo: string }> {
    const year = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    const from = year ? dayStr(year.startsOn)! : `${today.slice(0, 4)}-01-01`;
    const to = year ? dayStr(year.endsOn)! : `${today.slice(0, 4)}-12-31`;
    const shift = (s: string) => `${Number(s.slice(0, 4)) - 1}${s.slice(4)}`;
    return { from, to, prevFrom: shift(from), prevTo: shift(to) };
  }

  /** Project rows as the projects gallery, dashboard and pickers read them. */
  async projectRows(projects: ProjectListRecord[], today = todayStr()) {
    const [students, mentors, campuses] = await Promise.all([
      this.students(projects.map((p) => p.studentId)),
      this.employees(projects.map((p) => p.mentorId)),
      this.campusNames(),
    ]);
    return projects.map((p) => {
      const st = students.get(p.studentId);
      const progress = milestoneProgress(p.status === 'Active', p.milestones, today);
      return {
        id: p.id,
        code: p.code,
        title: p.title,
        summary: p.summary,
        stage: p.stage,
        status: p.status,
        startedOn: dayStr(p.startedOn),
        updatedAt: p.updatedAt.toISOString(),
        mentorId: p.mentorId,
        mentor: p.mentorId ? (mentors.get(p.mentorId)?.fullName ?? null) : null,
        studentId: p.studentId,
        studentName: st?.fullName ?? 'Unknown student',
        admissionNo: st?.admissionNo ?? '',
        grade: st?.grade ?? null,
        section: st?.section ?? null,
        campusName: campuses.get(p.campusId) ?? st?.campusName ?? '',
        ...progress,
        members: p._count.members,
      };
    });
  }

  /** Marks a project as changed (bumps updatedAt) after a change to one of its parts. */
  async touch(projectId: string) {
    await this.prisma.innovationProject.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
  }

  // -- notifications -------------------------------------------------------
  /** The student's own portal account and, optionally, their parents. */
  async notifyStudent(studentId: string, input: NotifyInput, family = true) {
    const accounts = await this.prisma.user.findMany({ where: { studentId, status: 'active' }, select: { id: true } });
    await this.notifications.notifyUsers(accounts.map((a) => a.id), input);
    if (family) await this.notifications.notifyGuardians(studentId, { ...input, route: undefined });
  }

  async notifyEmployee(employeeId: string | null | undefined, input: NotifyInput) {
    if (!employeeId) return;
    const accounts = await this.prisma.user.findMany({ where: { employeeId, status: 'active' }, select: { id: true } });
    await this.notifications.notifyUsers(accounts.map((a) => a.id), input);
  }
}
