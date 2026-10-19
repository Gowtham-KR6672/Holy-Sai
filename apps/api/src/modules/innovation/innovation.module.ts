import { Module, OnModuleInit } from '@nestjs/common';
import { can } from '../../common/auth-user';
import { PrismaService } from '../../common/prisma.service';
import { SearchService } from '../search/search.service';
import { AchievementsController } from './achievements.controller';
import { CompetitionsController } from './competitions.controller';
import { InnovationDashboardController } from './dashboard.controller';
import { IdeasController, MyIdeasController } from './ideas.controller';
import { InnovationService, STAGES } from './innovation.util';
import { MentorsController } from './mentors.controller';
import { MilestonesController } from './milestones.controller';
import { ProjectsController } from './projects.controller';

/** Student Innovation Lab: ideas → review → mentor → project → prototype → competition → achievement. */
@Module({
  controllers: [
    InnovationDashboardController,
    IdeasController,
    MyIdeasController,
    ProjectsController,
    MilestonesController,
    MentorsController,
    CompetitionsController,
    AchievementsController,
  ],
  providers: [InnovationService],
  exports: [InnovationService],
})
export class InnovationModule implements OnModuleInit {
  constructor(
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
    private readonly lab: InnovationService,
  ) {}

  onModuleInit() {
    // Ctrl K: projects by code or title, within the user's scope.
    this.search.register(async (user, q) => {
      if (!can(user, 'innovation.read', 'innovation.manage')) return [];
      const scope = await this.lab.studentScope(user);
      const rows = await this.prisma.innovationProject.findMany({
        where: {
          AND: [
            this.lab.projectWhere(user, scope),
            { OR: [{ code: { contains: q, mode: 'insensitive' } }, { title: { contains: q, mode: 'insensitive' } }] },
          ],
        },
        select: { id: true, code: true, title: true, stage: true },
        orderBy: { updatedAt: 'desc' },
        take: 5,
      });
      return rows.map((p) => ({ group: 'Projects', label: p.title, meta: `${p.code} · ${STAGES[p.stage] ?? 'Project'}`, icon: 'rocket', route: `/projects/${p.id}` }));
    });
  }
}
