import type { Prisma, PrismaClient } from '@prisma/client';
import { badRequest, conflict, fieldError } from '../../common/errors';
import { like } from '../../common/paging';

/**
 * Rebuild addition: a sign-in account is linked to the person it belongs to, so role-based apps (web and mobile)
 * show that person's own data — a student their record, a parent their children, staff their self-service.
 *   student role → User.studentId (core Student)
 *   parent role  → User.parentId  (core Guardian)
 *   other roles  → User.employeeId (core Employee), optional
 */
export type LinkKind = 'student' | 'parent' | 'employee';

export interface LinkedRecord { kind: LinkKind; id: string; name: string; meta: string | null }

export const linkKindFor = (roleKey: string): LinkKind => (roleKey === 'student' ? 'student' : roleKey === 'parent' ? 'parent' : 'employee');

/** Student and parent accounts must be linked, otherwise they would see nothing. */
export const linkRequired = (kind: LinkKind) => kind !== 'employee';

const LINK_FIELD = { student: 'studentId', parent: 'parentId', employee: 'employeeId' } as const;

type Db = PrismaClient | Prisma.TransactionClient;

/** Records of a kind matching a search, excluding records already linked to another account. */
export async function linkCandidates(db: Db, kind: LinkKind, q: string, take = 8): Promise<LinkedRecord[]> {
  const text = q.trim();
  const taken = await db.user.findMany({ where: { [LINK_FIELD[kind]]: { not: null } }, select: { studentId: true, parentId: true, employeeId: true } });
  const takenIds = taken.map((u) => u[LINK_FIELD[kind]]).filter((x): x is string => !!x);
  if (kind === 'student') {
    const rows = await db.student.findMany({
      where: { id: { notIn: takenIds }, ...(text ? { OR: [{ fullName: like(text) }, { admissionNo: like(text) }] } : {}) },
      orderBy: { fullName: 'asc' },
      take,
    });
    return rows.map((s) => ({ kind, id: s.id, name: s.fullName, meta: `${s.admissionNo}${s.status !== 'active' ? ` · ${s.status}` : ''}` }));
  }
  if (kind === 'parent') {
    const rows = await db.guardian.findMany({
      where: { id: { notIn: takenIds }, ...(text ? { OR: [{ fullName: like(text) }, { phone: like(text) }, { email: like(text) }] } : {}) },
      orderBy: { fullName: 'asc' },
      take,
    });
    return rows.map((g) => ({ kind, id: g.id, name: g.fullName, meta: [g.phone, g.email].filter(Boolean).join(' · ') || null }));
  }
  const rows = await db.employee.findMany({
    where: { id: { notIn: takenIds }, archivedAt: null, ...(text ? { OR: [{ fullName: like(text) }, { code: like(text) }, { email: like(text) }] } : {}) },
    orderBy: { fullName: 'asc' },
    take,
  });
  return rows.map((e) => ({ kind, id: e.id, name: e.fullName, meta: `${e.code} · ${e.designation}` }));
}

/** Name of the record an account is linked to (for the users list). */
export async function linkedRecords(db: Db, users: { id: string; studentId: string | null; parentId: string | null; employeeId: string | null }[]) {
  const ids = (k: 'studentId' | 'parentId' | 'employeeId') => users.map((u) => u[k]).filter((x): x is string => !!x);
  const [students, guardians, employees] = await Promise.all([
    db.student.findMany({ where: { id: { in: ids('studentId') } }, select: { id: true, fullName: true, admissionNo: true } }),
    db.guardian.findMany({ where: { id: { in: ids('parentId') } }, select: { id: true, fullName: true, phone: true } }),
    db.employee.findMany({ where: { id: { in: ids('employeeId') } }, select: { id: true, fullName: true, code: true } }),
  ]);
  const out = new Map<string, LinkedRecord>();
  for (const u of users) {
    const s = u.studentId && students.find((x) => x.id === u.studentId);
    const g = u.parentId && guardians.find((x) => x.id === u.parentId);
    const e = u.employeeId && employees.find((x) => x.id === u.employeeId);
    if (s) out.set(u.id, { kind: 'student', id: s.id, name: s.fullName, meta: s.admissionNo });
    else if (g) out.set(u.id, { kind: 'parent', id: g.id, name: g.fullName, meta: g.phone });
    else if (e) out.set(u.id, { kind: 'employee', id: e.id, name: e.fullName, meta: e.code });
  }
  return out;
}

/**
 * Works out which record a (new or re-roled) account links to: the record chosen in the form, or — when none was
 * chosen — the single parent/staff record with the same email or mobile. Returns the User columns to set.
 */
export async function resolveLink(
  db: Db,
  input: { kind: LinkKind; linkId?: string | null; email: string; phone: string | null; excludeUserId?: string },
): Promise<{ studentId: string | null; parentId: string | null; employeeId: string | null; campusId: string | null; name: string | null }> {
  const { kind } = input;
  let id = input.linkId || null;
  let campusId: string | null = null;
  let name: string | null = null;
  if (id) {
    if (kind === 'student') {
      const s = await db.student.findUnique({ where: { id } });
      if (!s) throw fieldError('linkId', 'Choose the student record this login belongs to');
      // School policy: a student who has left keeps their record, but their login stays disabled.
      if (s.status !== 'active') throw fieldError('linkId', `${s.fullName} is no longer enrolled (${s.status}), so a login cannot be linked`);
      campusId = s.campusId;
      name = s.fullName;
    } else if (kind === 'parent') {
      const g = await db.guardian.findUnique({ where: { id } });
      if (!g) throw fieldError('linkId', 'Choose the parent record this login belongs to');
      name = g.fullName;
    } else {
      const e = await db.employee.findUnique({ where: { id } });
      if (!e) throw fieldError('linkId', 'Choose the staff record this login belongs to');
      campusId = e.campusId;
      name = e.fullName;
    }
  } else if (kind === 'parent') {
    const matches = await db.guardian.findMany({
      where: { OR: [{ email: { equals: input.email, mode: 'insensitive' } }, ...(input.phone ? [{ phone: input.phone }] : [])] },
      take: 2,
    });
    if (matches.length === 1) [id, name] = [matches[0].id, matches[0].fullName];
  } else if (kind === 'employee') {
    const matches = await db.employee.findMany({ where: { email: { equals: input.email, mode: 'insensitive' }, archivedAt: null }, take: 2 });
    if (matches.length === 1) [id, name, campusId] = [matches[0].id, matches[0].fullName, matches[0].campusId];
  }
  if (!id && linkRequired(kind)) {
    throw fieldError('linkId', kind === 'student' ? 'Choose the student record this login belongs to' : 'Choose the parent record this login belongs to');
  }
  if (id) {
    const other = await db.user.findFirst({ where: { [LINK_FIELD[kind]]: id, ...(input.excludeUserId ? { NOT: { id: input.excludeUserId } } : {}) } });
    if (other) throw conflict(`${name ?? 'This record'} already has a sign-in account (${other.email})`);
  }
  return {
    studentId: kind === 'student' ? id : null,
    parentId: kind === 'parent' ? id : null,
    employeeId: kind === 'employee' ? id : null,
    campusId,
    name,
  };
}

/**
 * School policy: logins of students who have left stay disabled, and so do parent logins with no enrolled child.
 * Called before an account is re-activated.
 */
export async function assertCanActivate(db: Db, u: { studentId: string | null; parentId: string | null }) {
  if (u.studentId) {
    const s = await db.student.findUnique({ where: { id: u.studentId }, select: { fullName: true, status: true } });
    if (s && s.status !== 'active') throw badRequest(`${s.fullName} is no longer enrolled (${s.status}). Re-activate the student first; their login is restored with them.`);
  }
  if (u.parentId) {
    const links = await db.studentGuardian.findMany({ where: { guardianId: u.parentId }, select: { studentId: true } });
    if (links.length) {
      const active = await db.student.count({ where: { id: { in: links.map((l) => l.studentId) }, status: 'active' } });
      if (!active) throw badRequest("None of this parent's children are enrolled now, so the parent login stays disabled.");
    }
  }
}
