import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { SearchService } from '../search/search.service';
import { GuardedReadsService } from './guarded-reads.service';
import { available, visibleReports } from './reports.catalog';

/** Adds standard reports, group policies and open transfers to the global Ctrl K search. */
@Injectable()
export class InsightsSearch implements OnModuleInit {
  constructor(
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
    private readonly guarded: GuardedReadsService,
  ) {}

  onModuleInit() {
    this.search.register(async (user, q) => {
      const term = q.toLowerCase();
      const hits = [];
      if (user.permissions.has('reports.read') || user.permissions.has('users.manage')) {
        const centre = user.permissions.has('users.manage');
        hits.push(...visibleReports(user)
          .filter((r) => available(user, r) && `${r.title} ${r.description}`.toLowerCase().includes(term))
          .slice(0, 3)
          .map((r) => ({ group: 'Reports', label: r.title, meta: `${r.group} report`, icon: 'fileText', route: centre ? `/admin/reports/${r.key}` : '/reports' })));
      }
      if ((user.permissions.has('group.read') || user.permissions.has('group.manage')) && (await this.guarded.has('GroupPolicy'))) {
        const policies = await this.prisma.groupPolicy.findMany({
          where: { name: { contains: q, mode: 'insensitive' } }, orderBy: { name: 'asc' }, take: 3, select: { name: true, version: true, status: true },
        });
        hits.push(...policies.map((p) => ({ group: 'Group policies', label: p.name, meta: `${p.version} · ${p.status}`, icon: 'shield', route: `/group-policies?q=${encodeURIComponent(p.name)}` })));
      }
      return hits;
    });
  }
}
