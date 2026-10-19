import { Controller, Get, Query } from '@nestjs/common';
import type { InnovationAchievement, Prisma } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { paged } from '../../common/envelope';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ACHIEVEMENT_TYPES, InnovationService, asDate, dayStr, sortRows, type StudentInfo } from './innovation.util';

class AchievementQuery extends ListQuery {
  @IsOptional() @IsString() type?: string;
}

/** Student achievements (verified recognition on the Student 360 profile and portfolio). */
@Controller('innovation')
export class AchievementsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lab: InnovationService,
  ) {}

  @Get('achievements')
  @RequirePermissions('innovation.read', 'innovation.manage')
  async list(@Query() q: AchievementQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const scope = await this.lab.studentScope(user, q.campusId);
    const and: Prisma.InnovationAchievementWhereInput[] = [this.lab.byStudent(scope)];
    if (q.type) and.push({ type: q.type });
    if (q.q?.trim()) {
      const ids = await this.lab.matchingStudentIds(q.q);
      const term = { contains: q.q.trim(), mode: 'insensitive' as const };
      and.push({ OR: [{ title: term }, { type: term }, { level: term }, ...(ids.length ? [{ studentId: { in: ids } }] : [])] });
    }
    const where: Prisma.InnovationAchievementWhereInput = { AND: and };
    const sort = q.sort ?? 'date';
    const dir = q.dir ?? (sort === 'date' ? 'desc' : 'asc');

    if (sort === 'student') {
      const all = await this.prisma.innovationAchievement.findMany({ where });
      const rows = await this.rows(all);
      const sorted = sortRows(rows, 'student', dir, { student: (r) => r.studentName });
      return paged(sorted.slice(p.skip, p.skip + p.take), sorted.length, p);
    }
    const orderBy: Prisma.InnovationAchievementOrderByWithRelationInput[] =
      sort === 'title' ? [{ title: dir }]
        : sort === 'type' ? [{ type: dir }, { achievedOn: 'desc' }]
          : [{ achievedOn: dir }, { createdAt: dir }];
    const [list, total] = await Promise.all([
      this.prisma.innovationAchievement.findMany({ where, orderBy, skip: p.skip, take: p.take }),
      this.prisma.innovationAchievement.count({ where }),
    ]);
    return paged(await this.rows(list), total, p);
  }

  @Get('achievements/summary')
  @RequirePermissions('innovation.read', 'innovation.manage')
  async summary(@Query() q: ListQuery, @CurrentUser() user: AuthUser) {
    const scope = await this.lab.studentScope(user, q.campusId);
    const where = this.lab.byStudent(scope);
    const year = await this.lab.yearWindow();
    const [thisYear, lastYear, groups] = await Promise.all([
      this.prisma.innovationAchievement.count({ where: { ...where, achievedOn: { gte: asDate(year.from), lte: asDate(year.to) } } }),
      this.prisma.innovationAchievement.count({ where: { ...where, achievedOn: { gte: asDate(year.prevFrom), lte: asDate(year.prevTo) } } }),
      this.prisma.innovationAchievement.groupBy({ by: ['type'], where, _count: { _all: true } }),
    ]);
    const n = (...types: string[]) => groups.filter((g) => types.includes(g.type)).reduce((a, g) => a + g._count._all, 0);
    const total = groups.reduce((a, g) => a + g._count._all, 0);
    const competition = n('Competition', 'Innovation');
    const academic = n('Academic');
    return { thisYear, lastYear, competition, academic, other: total - competition - academic, total };
  }

  @Get('achievement-types')
  @RequirePermissions('innovation.read', 'innovation.manage')
  async types() {
    const used = await this.prisma.innovationAchievement.findMany({ distinct: ['type'], select: { type: true } });
    return [...new Set([...ACHIEVEMENT_TYPES, ...used.map((u) => u.type).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  }

  private async rows(list: InnovationAchievement[]) {
    const [students, projects] = await Promise.all([
      this.lab.students(list.map((a) => a.studentId)),
      this.projectCodes(list.map((a) => a.projectId)),
    ]);
    return list.map((a) => this.row(a, students, projects));
  }

  private async projectCodes(ids: (string | null)[]) {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map<string, string>();
    const rows = await this.prisma.innovationProject.findMany({ where: { id: { in: want } }, select: { id: true, code: true } });
    return new Map(rows.map((r) => [r.id, r.code]));
  }

  private row(a: InnovationAchievement, students: Map<string, StudentInfo>, projects: Map<string, string>) {
    const st = students.get(a.studentId);
    return {
      id: a.id,
      title: a.title,
      type: a.type,
      level: a.level,
      achievedOn: dayStr(a.achievedOn)!,
      verified: a.verified,
      verifiedBy: a.verifiedByName,
      studentId: a.studentId,
      studentName: st?.fullName ?? 'Unknown student',
      admissionNo: st?.admissionNo ?? '',
      grade: st?.grade ?? null,
      section: st?.section ?? null,
      projectId: a.projectId && projects.has(a.projectId) ? a.projectId : null,
      projectCode: a.projectId ? (projects.get(a.projectId) ?? null) : null,
    };
  }
}
