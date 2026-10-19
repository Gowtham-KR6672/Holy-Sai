import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth-user';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import type { ExamRole } from './ec.util';

/** Classes, students and staff for Paper Correction, read live from the Holy Sai records. */
@Injectable()
export class EcRoster {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /** "Grade 7 · GDV" (class name · campus code, as the examination form builds it) → the class. */
  async resolveClass(label: string) {
    const i = label.lastIndexOf(' · ');
    const name = (i >= 0 ? label.slice(0, i) : label).trim();
    const code = i >= 0 ? label.slice(i + 3).trim().toUpperCase() : '';
    const classes = await this.prisma.schoolClass.findMany({ where: { name: { equals: name, mode: 'insensitive' } }, include: { campus: true, sections: true } });
    return classes.find((c) => !code || c.campus.code.toUpperCase() === code) ?? (code ? null : classes[0] ?? null);
  }

  classLabel(c: { name: string; campus: { code: string } }) {
    return `${c.name} · ${c.campus.code.toUpperCase()}`;
  }

  async resolveSubject(name: string) {
    return this.prisma.subject.findFirst({ where: { OR: [{ name: { equals: name.trim(), mode: 'insensitive' } }, { code: { equals: name.trim(), mode: 'insensitive' } }] } });
  }

  /** Re-links examinations whose class, section or subject record was missing or renamed. */
  async relinkExams(): Promise<number> {
    const exams = await this.prisma.examCorrectionExam.findMany({ where: { OR: [{ classId: null }, { subjectId: null }, { section: { not: '' }, sectionId: null }] } });
    let n = 0;
    for (const e of exams) {
      const cls = e.classId ? null : await this.resolveClass(e.className);
      const subject = e.subjectId ? null : await this.resolveSubject(e.subject);
      const classId = e.classId ?? cls?.id ?? null;
      const section = e.section && !e.sectionId && classId ? await this.prisma.section.findFirst({ where: { classId, name: e.section } }) : null;
      const data = {
        ...(cls ? { classId: cls.id, campusId: cls.campusId } : {}),
        ...(subject ? { subjectId: subject.id } : {}),
        ...(section ? { sectionId: section.id } : {}),
      };
      if (Object.keys(data).length) {
        await this.prisma.examCorrectionExam.update({ where: { id: e.id }, data });
        n++;
      }
    }
    return n;
  }

  /** Active students of a class (every section), in the shape the pages read. */
  async students(classId: string, label: string) {
    const rows = await this.prisma.student.findMany({
      where: { status: 'active', section: { classId } },
      include: { section: { select: { name: true } } },
      orderBy: [{ section: { name: 'asc' } }, { rollNo: 'asc' }, { fullName: 'asc' }],
    });
    return rows.map((s) => ({ id: s.id, admission_no: s.admissionNo, name: s.fullName, class_name: label, section: s.section.name, roll_no: s.rollNo != null ? String(s.rollNo) : '' }));
  }

  /** Staff who can use Paper Correction, with their role on its pages. */
  async users(user: AuthUser) {
    const campusId = this.scope.campus(user);
    const rows = await this.prisma.user.findMany({
      where: {
        role: { permissions: { some: { permissionKey: { in: ['assessments.manage', 'settings.manage'] } } } },
        ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}),
      },
      include: { role: { include: { permissions: { where: { permissionKey: { in: ['assessments.manage', 'settings.manage'] } } } } } },
      orderBy: { fullName: 'asc' },
    });
    return rows.map((u) => {
      const keys = new Set(u.role.permissions.map((p) => p.permissionKey));
      const role: ExamRole = keys.has('settings.manage') ? 'admin' : u.role.scope === 'school' ? 'coordinator' : 'teacher';
      return { id: u.id, name: u.fullName, role, active: u.status === 'active' };
    });
  }
}
