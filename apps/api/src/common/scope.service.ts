import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from './auth-user';
import { forbidden } from './errors';
import { PrismaService } from './prisma.service';

/**
 * Data scope rules, applied on the server for every list and record:
 *  - school: the campus chosen in the header (or all campuses in group view, with dashboard.group)
 *  - class:  students in the teacher's sections
 *  - family: the parent's own children
 *  - self:   the user's own records
 */
@Injectable()
export class ScopeService {
  /** Extra section sources (e.g. timetable assignments), registered by the academics module. */
  private sectionResolvers: ((employeeId: string) => Promise<string[]>)[] = [];

  constructor(private readonly prisma: PrismaService) {}

  registerTeacherSections(fn: (employeeId: string) => Promise<string[]>) {
    this.sectionResolvers.push(fn);
  }

  /** The campus to filter by; undefined means every campus (group view). */
  campus(user: AuthUser, requested?: string | null): string | undefined {
    const wanted = requested && requested !== 'all' ? requested : undefined;
    if (user.scope === 'school') {
      if (wanted) return wanted;
      return user.permissions.has('dashboard.group') ? undefined : (user.campusId ?? undefined);
    }
    // Non-school scopes are pinned to their own campus (or unrestricted if none set; their row filters apply).
    if (wanted && user.campusId && wanted !== user.campusId) throw forbidden('That campus is outside your access');
    return user.campusId ?? undefined;
  }

  /** Sections a teacher may see: class-teacher sections plus any registered sources (timetable). */
  async teacherSectionIds(user: AuthUser): Promise<string[]> {
    if (!user.employeeId) return [];
    const own = await this.prisma.section.findMany({ where: { classTeacherId: user.employeeId }, select: { id: true } });
    const extra = (await Promise.all(this.sectionResolvers.map((fn) => fn(user.employeeId!)))).flat();
    return [...new Set([...own.map((s) => s.id), ...extra])];
  }

  /** Children of the signed-in parent. */
  async familyStudentIds(user: AuthUser): Promise<string[]> {
    if (!user.parentId) return [];
    const rows = await this.prisma.studentGuardian.findMany({ where: { guardianId: user.parentId }, select: { studentId: true } });
    return rows.map((r) => r.studentId);
  }

  /** Prisma filter for students this user may see. */
  async studentWhere(user: AuthUser, requestedCampus?: string | null): Promise<Prisma.StudentWhereInput> {
    if (user.scope === 'family') return { id: { in: await this.familyStudentIds(user) } };
    if (user.scope === 'self') return { id: user.studentId ?? '00000000-0000-0000-0000-000000000000' };
    if (user.scope === 'class' && !user.permissions.has('students.read')) {
      return { sectionId: { in: await this.teacherSectionIds(user) } };
    }
    const campusId = this.campus(user, requestedCampus);
    return campusId ? { campusId } : {};
  }

  /** Throws unless the user may see this student. */
  async assertStudent(user: AuthUser, studentId: string): Promise<void> {
    const where = await this.studentWhere(user);
    const n = await this.prisma.student.count({ where: { AND: [where, { id: studentId }] } });
    if (n === 0) throw forbidden('This student is outside your access');
  }
}
