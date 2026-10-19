import { Controller, Get, Query } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';
import { RequirePermissions } from '../../common/decorators';
import { paged } from '../../common/envelope';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';

class AuditQuery extends ListQuery {
  @IsOptional() @IsString() module?: string;
  @IsOptional() @IsString() action?: string;
  /** YYYY-MM-DD, inclusive */
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

@Controller()
@RequirePermissions('audit.read')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('audit-logs')
  async list(@Query() q: AuditQuery) {
    const p = pageOf(q, 50);
    const where: Prisma.AuditLogWhereInput = {
      ...(q.module ? { module: q.module } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.from || q.to
        ? { createdAt: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00`) } : {}), ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999`) } : {}) } }
        : {}),
      ...(q.q ? { OR: [{ userName: like(q.q) }, { description: like(q.q) }, { action: like(q.q) }, { entityId: like(q.q) }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paged(
      rows.map((a) => ({
        id: a.id,
        createdAt: a.createdAt.toISOString(),
        userName: a.userName,
        role: a.role,
        action: a.action,
        module: a.module,
        entityType: a.entityType,
        entityId: a.entityId,
        description: a.description,
        ip: a.ip,
        device: a.device,
        userAgent: a.userAgent,
      })),
      total,
      p,
    );
  }

  @Get('audit/facets')
  async facets() {
    const [modules, actions] = await Promise.all([
      this.prisma.auditLog.groupBy({ by: ['module'], _count: { _all: true }, orderBy: { module: 'asc' } }),
      this.prisma.auditLog.groupBy({ by: ['action'], orderBy: { action: 'asc' } }),
    ]);
    return { modules: modules.map((m) => ({ module: m.module, n: m._count._all })), actions: actions.map((a) => a.action) };
  }
}
