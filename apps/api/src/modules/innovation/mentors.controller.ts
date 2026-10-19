import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { badRequest, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { InnovationService } from './innovation.util';

class MentorQuery {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() campusId?: string;
  /** "true": every teaching / lab staff member (for "Add a mentor"), not just the panel. */
  @IsOptional() @IsString() all?: string;
}

class MentorDto {
  @IsBoolean({ message: 'Choose whether they are on the panel' }) isMentor: boolean;
  @IsOptional() @IsString() @MaxLength(160) specialisation?: string | null;
}

/** The staff mentor panel and each mentor's current load. */
@Controller('innovation')
export class MentorsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lab: InnovationService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  @Get('mentors')
  @RequirePermissions('innovation.read', 'innovation.manage')
  async list(@Query() q: MentorQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const all = q.all === 'true' || q.all === '1';
    const [panel, mentoring] = await Promise.all([
      this.prisma.innovationMentor.findMany({ where: { isActive: true } }),
      this.prisma.innovationProject.findMany({ where: { status: 'Active', mentorId: { not: null } }, select: { mentorId: true }, distinct: ['mentorId'] }),
    ]);
    const panelIds = new Set(panel.map((m) => m.employeeId));
    const ids = [...panelIds, ...mentoring.map((m) => m.mentorId!)];
    const or: Prisma.EmployeeWhereInput[] = [{ id: { in: ids } }];
    if (all) or.push({ employeeType: 'teaching' }, { category: 'Lab Staff' });
    const term = q.q?.trim();
    const employees = await this.prisma.employee.findMany({
      where: {
        AND: [
          { OR: or },
          { archivedAt: null, employmentStatus: { not: 'exited' } },
          campusId ? { campusId } : {},
          term
            ? {
              OR: [
                { fullName: { contains: term, mode: 'insensitive' } },
                { code: { contains: term, mode: 'insensitive' } },
                { designation: { contains: term, mode: 'insensitive' } },
                { department: { contains: term, mode: 'insensitive' } },
                { specialisation: { contains: term, mode: 'insensitive' } },
              ],
            }
            : {},
        ],
      },
      select: { id: true, code: true, fullName: true, designation: true, department: true, campusId: true, specialisation: true },
      orderBy: { fullName: 'asc' },
    });
    if (!employees.length) return [];
    const empIds = employees.map((e) => e.id);
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [projects, feedback, campuses] = await Promise.all([
      this.prisma.innovationProject.findMany({
        where: { mentorId: { in: empIds } },
        select: { id: true, code: true, title: true, stage: true, status: true, mentorId: true, updatedAt: true, members: { select: { studentId: true } } },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.innovationFeedback.groupBy({ by: ['authorEmployeeId'], where: { authorEmployeeId: { in: empIds }, createdAt: { gte: since } }, _count: { _all: true } }),
      this.lab.campusNames(),
    ]);
    const panelSpec = new Map(panel.map((m) => [m.employeeId, m.specialisation]));
    const rows = employees.map((e) => {
      const mine = projects.filter((p) => p.mentorId === e.id);
      const active = mine.filter((p) => p.status === 'Active');
      const students = new Set(active.flatMap((p) => p.members.map((m) => m.studentId)));
      return {
        id: e.id,
        employeeCode: e.code,
        name: e.fullName,
        designation: e.designation,
        department: e.department,
        campusName: campuses.get(e.campusId) ?? '',
        isMentor: panelIds.has(e.id),
        specialisation: panelSpec.get(e.id) ?? e.specialisation ?? null,
        activeProjects: active.length,
        completedProjects: mine.filter((p) => p.status === 'Completed').length,
        students: students.size,
        projects: active.map((p) => ({ id: p.id, code: p.code, title: p.title, stage: p.stage })),
        feedback30d: feedback.find((f) => f.authorEmployeeId === e.id)?._count._all ?? 0,
      };
    });
    return rows.sort((a, b) => Number(b.isMentor) - Number(a.isMentor) || a.name.localeCompare(b.name));
  }

  @Patch('mentors/:id')
  @RequirePermissions('innovation.manage')
  async setPanel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MentorDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const emp = await this.prisma.employee.findUnique({ where: { id }, select: { id: true, fullName: true, campusId: true, employmentStatus: true, archivedAt: true } });
    if (!emp) throw notFound('Staff member');
    const current = await this.prisma.innovationMentor.findUnique({ where: { employeeId: id } });
    if (dto.isMentor) {
      if (emp.employmentStatus === 'exited' || emp.archivedAt) throw badRequest(`${emp.fullName} is no longer on the staff`);
      if (current?.isActive && dto.specialisation === undefined) return ok({ id, isMentor: true }, 'Added to the mentor panel');
      await this.prisma.innovationMentor.upsert({
        where: { employeeId: id },
        create: { employeeId: id, isActive: true, specialisation: dto.specialisation?.trim() || null, addedById: user.id },
        update: { isActive: true, ...(dto.specialisation !== undefined ? { specialisation: dto.specialisation?.trim() || null } : {}), addedById: current?.isActive ? undefined : user.id },
      });
      if (!current?.isActive) {
        await this.audit.record({
          user, action: 'create', module: 'innovation', entityType: 'innovation_mentor', entityId: id, campusId: emp.campusId,
          description: `Added ${emp.fullName} to the Innovation Lab mentor panel`, req,
        });
        await this.lab.notifyEmployee(id, {
          topic: 'innovation', module: 'innovation', category: 'Information', icon: 'graduation', title: 'You joined the Innovation Lab mentor panel',
          body: 'You can now be assigned as a mentor to student projects.', route: '/mentors', campusId: emp.campusId,
        });
      }
      return ok({ id, isMentor: true }, 'Added to the mentor panel');
    }
    if (!current?.isActive) return ok({ id, isMentor: false }, 'Removed from the mentor panel');
    await this.prisma.innovationMentor.update({ where: { employeeId: id }, data: { isActive: false } });
    const active = await this.prisma.innovationProject.count({ where: { mentorId: id, status: 'Active' } });
    await this.audit.record({
      user, action: 'delete', module: 'innovation', entityType: 'innovation_mentor', entityId: id, campusId: emp.campusId,
      description: `Removed ${emp.fullName} from the Innovation Lab mentor panel${active ? ` (still mentoring ${active} active project(s))` : ''}`, req,
    });
    return ok({ id, isMentor: false }, 'Removed from the mentor panel');
  }
}
