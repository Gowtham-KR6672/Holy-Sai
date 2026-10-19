import { Body, Controller, Get, Next, OnModuleInit, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { can, type AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { forbidden } from '../../common/errors';
import { like, ListQuery } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { SearchService } from '../search/search.service';
import { DirectoryQuery, ParentDto } from './dto';
import { IdPipe } from './id.pipe';
import { ParentsService } from './parents.service';
import { UUID } from './parents.util';

const READ = ['parents.read', 'communication.read'];

/** The parent directory: families with children, engagement, last interaction, PTM state and app accounts. */
@Controller('parent-directory')
export class DirectoryController implements OnModuleInit {
  constructor(
    private readonly parents: ParentsService,
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
  ) {}

  /** Parents in the global search (Ctrl K). */
  onModuleInit() {
    this.search.register(async (user, q) => {
      if (!can(user, 'parents.read')) return [];
      const where = await this.parents.guardianWhere(user);
      const rows = await this.prisma.guardian.findMany({
        where: { AND: [where, { OR: [{ fullName: like(q) }, { phone: like(q) }, { email: like(q) }] }] },
        include: { students: { include: { student: { select: { fullName: true } } } } },
        orderBy: { fullName: 'asc' },
        take: 5,
      });
      return rows.map((g) => ({
        group: 'Parents',
        label: g.fullName,
        meta: [g.phone, g.students.map((s) => s.student.fullName).join(', ')].filter(Boolean).join(' · '),
        icon: 'users',
        route: `/parent-directory?parent=${g.id}`,
      }));
    });
  }

  @Get()
  @RequirePermissions(...READ)
  list(@Query() q: DirectoryQuery, @CurrentUser() user: AuthUser) {
    return this.parents.directory(user, q);
  }

  @Get('summary')
  @RequirePermissions(...READ)
  summary(@Query() q: ListQuery, @CurrentUser() user: AuthUser) {
    return this.parents.summary(user, q.campusId);
  }
}

/**
 * Staff view of a parent record. GET /parents/me and the family routes belong to the family portal: for
 * paths that are not a record id these handlers step aside so that module's routes answer them.
 */
@Controller('parents')
export class ParentsController {
  constructor(private readonly parents: ParentsService) {}

  @Post()
  @RequirePermissions('parents.manage')
  async create(@Body() dto: ParentDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return ok(await this.parents.create(dto, user, req), 'Parent created');
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res() res: Response, @Next() next: NextFunction) {
    if (!UUID.test(id)) return next();
    if (!can(user, ...READ)) throw forbidden('This is not available for your role');
    await this.parents.assertGuardian(user, id);
    res.json({ success: true, data: await this.parents.record(id), message: 'OK' });
  }

  @Get(':id/children')
  async children(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res() res: Response, @Next() next: NextFunction) {
    if (!UUID.test(id)) return next();
    if (!can(user, ...READ)) throw forbidden('This is not available for your role');
    await this.parents.assertGuardian(user, id);
    res.json({ success: true, data: await this.parents.children(id), message: 'OK' });
  }

  @Put(':id')
  @RequirePermissions('parents.manage')
  async update(@Param('id', IdPipe) id: string, @Body() dto: ParentDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return ok(await this.parents.update(id, dto, user, req), 'Parent updated');
  }
}
