import type { AuthUser } from '../../common/auth-user';
import { notFound } from '../../common/errors';
import type { PrismaService } from '../../common/prisma.service';
import type { ScopeService } from '../../common/scope.service';
import { UUID } from './intel.util';

/** A student by id or admission number ("HS-2026-1041"), within the user's scope. */
export async function findStudent(prisma: PrismaService, scope: ScopeService, user: AuthUser, ref: string) {
  const key = decodeURIComponent(ref).trim();
  const student = await prisma.student.findFirst({
    where: UUID.test(key) ? { id: key } : { admissionNo: { equals: key, mode: 'insensitive' } },
    select: {
      id: true, fullName: true, admissionNo: true, house: true, campusId: true, sectionId: true, admittedOn: true, status: true,
      campus: { select: { name: true } },
      section: { select: { name: true, class: { select: { name: true, gradeLevel: true } } } },
    },
  });
  if (!student) throw notFound('Student');
  await scope.assertStudent(user, student.id);
  return student;
}
