import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { forbidden, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { sectionLabel } from './academics.util';

export interface SectionInfo {
  id: string;
  name: string;
  label: string;
  classId: string;
  className: string;
  gradeLevel: number;
  stage: string | null;
  campusId: string;
  campusName: string;
  room: string | null;
  classTeacherId: string | null;
}

/**
 * Who may see which sections in Academics and Attendance:
 *  - school-level staff (school scope with students.read): the campus chosen in the header (or every campus in group view)
 *  - teachers and other restricted roles: the sections they are class teacher of or teach in the timetable
 */
@Injectable()
export class AcademicsAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /** True when the user only sees their own sections. */
  restricted(user: AuthUser): boolean {
    return user.scope !== 'school' || !user.permissions.has('students.read');
  }

  /** School-level reviewer: may approve lesson plans, finalise moderation and release report cards. */
  isSchoolLevel(user: AuthUser): boolean {
    return user.scope === 'school' && user.permissions.has('students.read');
  }

  /** Prisma filter on Section for the user's scope. */
  async sectionWhere(user: AuthUser, campusId?: string | null): Promise<Prisma.SectionWhereInput> {
    if (this.restricted(user)) return { id: { in: await this.scope.teacherSectionIds(user) } };
    const campus = this.scope.campus(user, campusId);
    return campus ? { campusId: campus } : {};
  }

  /** Section ids in scope, or undefined when only a campus filter applies. */
  async sectionIdsOrCampus(user: AuthUser, campusId?: string | null): Promise<{ sectionIds?: string[]; campusId?: string }> {
    if (this.restricted(user)) return { sectionIds: await this.scope.teacherSectionIds(user) };
    return { campusId: this.scope.campus(user, campusId) };
  }

  async sections(user: AuthUser, campusId?: string | null): Promise<SectionInfo[]> {
    const rows = await this.prisma.section.findMany({
      where: await this.sectionWhere(user, campusId),
      include: { class: { include: { campus: true } } },
    });
    return rows.map(toInfo).sort(bySection);
  }

  async sectionInfo(ids: string[]): Promise<Map<string, SectionInfo>> {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return new Map();
    const rows = await this.prisma.section.findMany({ where: { id: { in: uniq } }, include: { class: { include: { campus: true } } } });
    return new Map(rows.map((r) => [r.id, toInfo(r)]));
  }

  /** Loads a section and throws unless the user may work with it. */
  async assertSection(user: AuthUser, sectionId: string): Promise<SectionInfo> {
    const s = await this.prisma.section.findUnique({ where: { id: sectionId }, include: { class: { include: { campus: true } } } });
    if (!s) throw notFound('Section');
    if (!(await this.canSeeSection(user, s.id, s.campusId))) throw forbidden('This class is outside your access');
    return toInfo(s);
  }

  async canSeeSection(user: AuthUser, sectionId: string, campusId: string): Promise<boolean> {
    if (this.restricted(user)) return (await this.scope.teacherSectionIds(user)).includes(sectionId);
    if (user.scope !== 'school') return false;
    if (user.permissions.has('dashboard.group') || !user.campusId) return true;
    return user.campusId === campusId;
  }

  /** Active students per section. */
  async studentCounts(sectionIds: string[]): Promise<Map<string, number>> {
    if (!sectionIds.length) return new Map();
    const g = await this.prisma.student.groupBy({ by: ['sectionId'], where: { sectionId: { in: sectionIds }, status: 'active' }, _count: { _all: true } });
    return new Map(g.map((x) => [x.sectionId, x._count._all]));
  }

  async subjectNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    if (!uniq.length) return new Map();
    const rows = await this.prisma.subject.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async employeeNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    if (!uniq.length) return new Map();
    const rows = await this.prisma.employee.findMany({ where: { id: { in: uniq } }, select: { id: true, fullName: true } });
    return new Map(rows.map((r) => [r.id, r.fullName]));
  }

  /** Signed-in accounts linked to staff records. */
  async usersForEmployees(employeeIds: (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniq = [...new Set(employeeIds.filter((x): x is string => !!x))];
    if (!uniq.length) return new Map();
    const rows = await this.prisma.user.findMany({ where: { employeeId: { in: uniq }, status: 'active' }, select: { id: true, employeeId: true } });
    return new Map(rows.map((r) => [r.employeeId!, r.id]));
  }

  /** Academic leads who review and approve: school-scope accounts holding academics.manage (campus-wide or group). */
  async schoolLeads(campusId: string | null | undefined, excludeUserId?: string): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        status: 'active',
        role: { scope: 'school', permissions: { some: { permissionKey: 'academics.manage' } } },
        AND: [
          { role: { permissions: { some: { permissionKey: 'students.read' } } } },
          ...(campusId ? [{ OR: [{ campusId }, { campusId: null }, { role: { permissions: { some: { permissionKey: 'dashboard.group' } } } }] }] : []),
        ],
        ...(excludeUserId ? { NOT: { id: excludeUserId } } : {}),
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** Guardian accounts (parent users) per student. */
  async guardianUsers(studentIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!studentIds.length) return out;
    const links = await this.prisma.studentGuardian.findMany({ where: { studentId: { in: studentIds } }, select: { studentId: true, guardianId: true } });
    if (!links.length) return out;
    const users = await this.prisma.user.findMany({ where: { parentId: { in: [...new Set(links.map((l) => l.guardianId))] }, status: 'active' }, select: { id: true, parentId: true } });
    const byGuardian = new Map<string, string[]>();
    for (const u of users) byGuardian.set(u.parentId!, [...(byGuardian.get(u.parentId!) ?? []), u.id]);
    for (const l of links) {
      const ids = byGuardian.get(l.guardianId) ?? [];
      if (ids.length) out.set(l.studentId, [...(out.get(l.studentId) ?? []), ...ids]);
    }
    return out;
  }
}

type SectionWithClass = Prisma.SectionGetPayload<{ include: { class: { include: { campus: true } } } }>;

function toInfo(s: SectionWithClass): SectionInfo {
  return {
    id: s.id,
    name: s.name,
    label: sectionLabel(s.class.name, s.name),
    classId: s.classId,
    className: s.class.name,
    gradeLevel: s.class.gradeLevel,
    stage: s.class.stage,
    campusId: s.campusId,
    campusName: s.class.campus.shortName || s.class.campus.name,
    room: s.room,
    classTeacherId: s.classTeacherId,
  };
}

export function bySection(a: SectionInfo, b: SectionInfo) {
  return a.campusName.localeCompare(b.campusName) || a.gradeLevel - b.gradeLevel || a.className.localeCompare(b.className) || a.name.localeCompare(b.name);
}
