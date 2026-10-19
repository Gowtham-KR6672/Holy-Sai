import { Controller, Get, OnModuleInit, Query } from '@nestjs/common';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser } from '../../common/decorators';
import { like } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { SearchService } from './search.service';

@Controller('search')
export class SearchController implements OnModuleInit {
  constructor(
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /** Core providers: students and staff. Modules add leads, receipts, devices and more. */
  onModuleInit() {
    this.search.register(async (user, q) => {
      if (!['students.read', 'students.read_assigned', 'parent_portal.use'].some((p) => user.permissions.has(p))) return [];
      const where = await this.scope.studentWhere(user);
      const rows = await this.prisma.student.findMany({
        where: { AND: [where, { OR: [{ fullName: like(q) }, { admissionNo: like(q) }] }] },
        include: { section: { include: { class: true } } },
        take: 6,
        orderBy: { fullName: 'asc' },
      });
      return rows.map((s) => ({
        group: 'Students',
        label: s.fullName,
        meta: `${s.admissionNo} · ${s.section.class.name}${s.section.name}`,
        icon: 'user',
        route: `/student-360/${s.id}`,
      }));
    });
    this.search.register(async (user, q) => {
      if (!user.permissions.has('hr.read')) return [];
      const rows = await this.prisma.employee.findMany({
        where: { archivedAt: null, OR: [{ fullName: like(q) }, { code: like(q) }, { designation: like(q) }] },
        take: 5,
        orderBy: { fullName: 'asc' },
      });
      return rows.map((e) => ({ group: 'Staff', label: e.fullName, meta: `${e.code} · ${e.designation}`, icon: 'idCard', route: `/workforce?employee=${e.id}` }));
    });
  }

  @Get()
  find(@Query('q') q: string, @CurrentUser() user: AuthUser) {
    return this.search.search(user, q ?? '');
  }
}
