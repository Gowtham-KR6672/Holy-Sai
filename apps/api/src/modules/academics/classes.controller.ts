import { Body, Controller, Get, Param, Put, Query, Req } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { fieldError } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AcademicsAccess } from './academics.access';
import { asDate, round1, schoolToday } from './academics.util';

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class ClassQuery extends ListQuery {
  @IsOptional() @IsString() grade?: string;
  @IsOptional() @IsIn(['Marked', 'Partial', 'Not marked', 'No students']) register?: string;
}

class SectionUpdateDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID('all', { message: 'Choose a teacher' }) classTeacherId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40, { message: 'Use 40 characters or fewer' }) room?: string | null;
}

/** Sections, classes and subjects as Academics sees them (the tables themselves belong to School Setup). */
@Controller('academics')
export class ClassesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademicsAccess,
    private readonly audit: AuditService,
  ) {}

  /** Sections the signed-in user may work with (teachers: their own; staff: the header campus). */
  @Get('sections')
  @RequirePermissions('academics.read', 'attendance.read', 'attendance.mark')
  async sections(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const sections = await this.access.sections(user, q.campusId);
    const ids = sections.map((s) => s.id);
    const [counts, mine] = await Promise.all([
      this.access.studentCounts(ids),
      user.employeeId && ids.length
        ? this.prisma.timetableEntry.findMany({
            where: { sectionId: { in: ids }, OR: [{ employeeId: user.employeeId }, { substituteId: user.employeeId }], subjectId: { not: null } },
            select: { sectionId: true, subjectId: true },
          })
        : Promise.resolve([] as { sectionId: string; subjectId: string | null }[]),
    ]);
    const subjects = await this.access.subjectNames(mine.map((m) => m.subjectId));
    return sections.map((s) => ({
      id: s.id,
      label: s.label,
      name: s.name,
      classId: s.classId,
      className: s.className,
      gradeLevel: s.gradeLevel,
      campusId: s.campusId,
      campusName: s.campusName,
      room: s.room,
      students: counts.get(s.id) ?? 0,
      mySubjects: [...new Set(mine.filter((m) => m.sectionId === s.id).map((m) => subjects.get(m.subjectId!)).filter((x): x is string => !!x))].sort(),
      isClassTeacher: !!user.employeeId && s.classTeacherId === user.employeeId,
    }));
  }

  /** Sets a section's class teacher and home room. */
  @Put('sections/:id')
  @RequirePermissions('academics.manage')
  async updateSection(@Param('id') id: string, @Body() dto: SectionUpdateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const s = await this.access.assertSection(user, id);
    const data: { classTeacherId?: string | null; room?: string | null } = {};
    if (dto.classTeacherId !== undefined) {
      if (dto.classTeacherId) {
        const t = await this.prisma.employee.findUnique({ where: { id: dto.classTeacherId } });
        if (!t || t.archivedAt || t.employmentStatus === 'exited') throw fieldError('classTeacherId', 'Choose a current member of staff');
        if (t.employeeType !== 'teaching') throw fieldError('classTeacherId', 'The class teacher must be a teacher');
        if (t.campusId !== s.campusId) throw fieldError('classTeacherId', 'Choose a teacher at the same campus');
      }
      data.classTeacherId = dto.classTeacherId || null;
    }
    if (dto.room !== undefined) data.room = dto.room?.trim() || null;
    await this.prisma.section.update({ where: { id }, data });
    const names = await this.access.employeeNames([data.classTeacherId]);
    const notes = [
      data.classTeacherId !== undefined ? `class teacher ${data.classTeacherId ? names.get(data.classTeacherId) : 'removed'}` : null,
      data.room !== undefined ? `room ${data.room ?? 'cleared'}` : null,
    ].filter(Boolean);
    await this.audit.record({ user, action: 'update', module: 'academics', entityType: 'section', entityId: id, campusId: s.campusId, description: `Updated ${s.label}${notes.length ? `: ${notes.join(', ')}` : ''}`, req });
    return ok({ id }, `${s.label} updated`);
  }

  @Get('classes/summary')
  @RequirePermissions('academics.read')
  async classSummary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const sections = await this.access.sections(user, q.campusId);
    return {
      sections: sections.length,
      classes: new Set(sections.map((s) => s.classId)).size,
      withoutClassTeacher: sections.filter((s) => !s.classTeacherId).length,
    };
  }

  /** Sections with class teacher, room and today's register. */
  @Get('classes')
  @RequirePermissions('academics.read')
  async classes(@Query() q: ClassQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    let sections = await this.access.sections(user, q.campusId);
    if (q.grade) sections = sections.filter((s) => String(s.gradeLevel) === q.grade);
    const ids = sections.map((s) => s.id);
    const today = asDate(schoolToday());
    const [counts, teachers, marks] = await Promise.all([
      this.access.studentCounts(ids),
      this.access.employeeNames(sections.map((s) => s.classTeacherId)),
      ids.length
        ? this.prisma.studentAttendance.groupBy({ by: ['sectionId', 'status'], where: { sectionId: { in: ids }, date: today }, _count: { _all: true } })
        : Promise.resolve([]),
    ]);
    let rows = sections.map((s) => {
      const mine = marks.filter((m) => m.sectionId === s.id);
      const marked = mine.reduce((n, m) => n + m._count._all, 0);
      const present = mine.filter((m) => m.status === 'present' || m.status === 'late').reduce((n, m) => n + m._count._all, 0);
      const students = counts.get(s.id) ?? 0;
      return {
        id: s.id,
        name: s.label,
        section: s.name,
        gradeLevel: s.gradeLevel,
        campusName: s.campusName,
        room: s.room,
        classTeacherId: s.classTeacherId,
        classTeacher: s.classTeacherId ? teachers.get(s.classTeacherId) ?? null : null,
        students,
        marked,
        present,
        attendance: marked ? Math.round(round1((100 * present) / marked)) : null,
        register: students === 0 ? 'No students' : marked >= students ? 'Marked' : marked > 0 ? 'Partial' : 'Not marked',
        _order: 0,
      };
    });
    if (q.register) rows = rows.filter((r) => r.register === q.register);
    if (q.q) {
      const term = q.q.trim().toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(term) || (r.classTeacher ?? '').toLowerCase().includes(term) || (r.room ?? '').toLowerCase().includes(term));
    }
    rows.forEach((r, i) => (r._order = i));
    const dir = q.dir === 'desc' ? -1 : 1;
    const key = q.sort ?? 'name';
    const val = (r: (typeof rows)[number]): number | string => {
      switch (key) {
        case 'students': return r.students;
        case 'teacher': return r.classTeacher ?? '￿';
        case 'room': return r.room ?? '￿';
        case 'attendance': return r.attendance ?? -1;
        default: return r._order;
      }
    };
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return c * dir || a._order - b._order;
    });
    const total = rows.length;
    return paged(rows.slice(p.skip, p.skip + p.take).map(({ _order, ...r }) => r), total, p);
  }

  /** Subjects with staffing (from the timetable), average marks and objective coverage. */
  @Get('subjects')
  @RequirePermissions('academics.read')
  async subjects(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const scope = await this.access.sectionIdsOrCampus(user, q.campusId);
    const entryWhere = scope.sectionIds ? { sectionId: { in: scope.sectionIds } } : scope.campusId ? { campusId: scope.campusId } : {};
    const assessWhere = scope.sectionIds
      ? { OR: [{ sectionId: { in: scope.sectionIds } }, { sectionId: null, classId: { in: await this.classIdsOf(scope.sectionIds) } }] }
      : scope.campusId ? { campusId: scope.campusId } : {};
    const [subjects, entries, objectives, assessments] = await Promise.all([
      this.prisma.subject.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
      this.prisma.timetableEntry.findMany({ where: { ...entryWhere, subjectId: { not: null } }, select: { subjectId: true, sectionId: true, employeeId: true } }),
      this.prisma.curriculumObjective.groupBy({ by: ['subjectId'], _avg: { coveragePct: true }, _count: { _all: true } }),
      this.prisma.assessment.findMany({ where: assessWhere, select: { subjectId: true, maxMarks: true, marks: { where: { isAbsent: false, marks: { not: null } }, select: { marks: true } } } }),
    ]);
    return subjects.map((s) => {
      const mine = entries.filter((e) => e.subjectId === s.id);
      const obj = objectives.find((o) => o.subjectId === s.id);
      const pcts = assessments.filter((a) => a.subjectId === s.id && a.maxMarks > 0).flatMap((a) => a.marks.map((m) => (100 * (m.marks ?? 0)) / a.maxMarks));
      return {
        id: s.id,
        code: s.code,
        name: s.name,
        stage: s.stageScope && s.stageScope !== 'All' ? s.stageScope : null,
        isCore: !s.isElective,
        teachers: new Set(mine.map((e) => e.employeeId).filter(Boolean)).size,
        classes: new Set(mine.map((e) => e.sectionId)).size,
        average: pcts.length ? round1(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
        coverage: obj ? Math.round(obj._avg.coveragePct ?? 0) : null,
        objectives: obj?._count._all ?? 0,
      };
    });
  }

  private async classIdsOf(sectionIds: string[]) {
    if (!sectionIds.length) return [];
    const rows = await this.prisma.section.findMany({ where: { id: { in: sectionIds } }, select: { classId: true } });
    return [...new Set(rows.map((r) => r.classId))];
  }
}
