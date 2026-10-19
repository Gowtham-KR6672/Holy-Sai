import { Injectable } from '@nestjs/common';
import { type AuthUser, can } from '../../common/auth-user';
import { badRequest, forbidden, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { ParentsService } from '../parents/parents.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Staff who may open a family's record (the parent directory permissions). */
export const FAMILY_STAFF = ['parents.read', 'communication.read'];

export interface ChildAccess {
  studentId: string;
  firstName: string;
  fullName: string;
  admissionNo: string;
  campusId: string;
  status: string;
  /** family = the child's own parent; staff = school staff with the child in scope. */
  viewer: 'family' | 'staff';
  /** The family the child is viewed through (the parent's guardian id, or the family a staff member opened). */
  guardianId: string | null;
  relationship: string | null;
  isPrimary: boolean;
}

const STUDENT_PICK = { id: true, firstName: true, fullName: true, admissionNo: true, campusId: true, status: true } as const;

/**
 * Who may see or act on a child in the family portal.
 *  - Parents: only children linked to their own guardian record (StudentGuardian). Writes need an active child.
 *  - Staff: read-only, with the module permission the caller names, the child in their data scope and, for the
 *    /parents/:pid/... routes, the family inside their parent-directory scope.
 */
@Injectable()
export class FamilyAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly parents: ParentsService,
  ) {}

  private async link(guardianId: string, studentId: string) {
    return this.prisma.studentGuardian.findUnique({
      where: { studentId_guardianId: { studentId, guardianId } },
      select: { relationship: true, isPrimary: true, student: { select: STUDENT_PICK } },
    });
  }

  private async notLinked(studentId: string): Promise<never> {
    const exists = await this.prisma.student.count({ where: { id: studentId } });
    throw exists ? forbidden('This child is not linked to your account') : notFound('Student');
  }

  /** A child of the signed-in parent (writes). `active` refuses children who have left the school. */
  async ownChild(user: AuthUser, studentId: string, opts: { active?: boolean } = {}): Promise<ChildAccess> {
    if (!isUuid(studentId)) throw notFound('Student');
    if (!user.parentId) throw forbidden('Only parent accounts can do this');
    const l = await this.link(user.parentId, studentId);
    if (!l) return this.notLinked(studentId);
    if (opts.active && l.student.status !== 'active') {
      throw badRequest(`${l.student.firstName} is no longer enrolled at the school. Please contact the school office.`);
    }
    return this.access(l.student, 'family', user.parentId, l.relationship, l.isPrimary);
  }

  /** Read access to a child: the child's own parent, or staff holding one of `staffPerms` with the child in scope. */
  async readChild(user: AuthUser, studentId: string, staffPerms: string[]): Promise<ChildAccess> {
    if (!isUuid(studentId)) throw notFound('Student');
    if (user.parentId) {
      const l = await this.link(user.parentId, studentId);
      if (l) return this.access(l.student, 'family', user.parentId, l.relationship, l.isPrimary);
    }
    if (user.scope !== 'family' && staffPerms.length && can(user, ...staffPerms)) {
      const s = await this.prisma.student.findUnique({ where: { id: studentId }, select: STUDENT_PICK });
      if (!s) throw notFound('Student');
      await this.scope.assertStudent(user, studentId);
      return this.access(s, 'staff', null, null, false);
    }
    return this.notLinked(studentId);
  }

  /**
   * A child seen through a family (/parents/:pid/children/:cid/...): the parent themselves, or staff with the
   * parent-directory permissions for that family plus `staffPerms` (when given) and the child in scope.
   */
  async familyChild(user: AuthUser, guardianId: string, studentId: string, staffPerms: string[] = []): Promise<ChildAccess> {
    if (!isUuid(guardianId) || !isUuid(studentId)) throw notFound('Student');
    if (user.parentId && user.parentId === guardianId) {
      const l = await this.link(guardianId, studentId);
      if (!l) return this.notLinked(studentId);
      return this.access(l.student, 'family', guardianId, l.relationship, l.isPrimary);
    }
    if (user.scope === 'family' || !can(user, ...FAMILY_STAFF) || (staffPerms.length && !can(user, ...staffPerms))) {
      throw forbidden('This family is outside your access');
    }
    await this.parents.assertGuardian(user, guardianId);
    const l = await this.link(guardianId, studentId);
    if (!l) throw notFound('Child');
    await this.scope.assertStudent(user, studentId);
    return this.access(l.student, 'staff', guardianId, l.relationship, l.isPrimary);
  }

  private access(
    s: { id: string; firstName: string; fullName: string; admissionNo: string; campusId: string; status: string },
    viewer: 'family' | 'staff', guardianId: string | null, relationship: string | null, isPrimary: boolean,
  ): ChildAccess {
    return {
      studentId: s.id, firstName: s.firstName, fullName: s.fullName, admissionNo: s.admissionNo, campusId: s.campusId, status: s.status,
      viewer, guardianId, relationship, isPrimary,
    };
  }
}
