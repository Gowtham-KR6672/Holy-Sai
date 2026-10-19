import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { SafetyModule } from '../safety/safety.module';
import { TransportModule } from '../transport/transport.module';
import { CommandCenterService } from './command-center.service';
import { DashboardController } from './dashboard.controller';
import { GroupController } from './group.controller';
import { GroupMetricsService } from './group-metrics.service';
import { GuardedReadsService } from './guarded-reads.service';
import { InsightsSearch } from './insights.search';
import { OverviewService } from './overview.service';
import { PoliciesController } from './policies.controller';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

/**
 * Insights: the Owner Overview and Command Center dashboards, the Report Centre (catalog, preview, CSV export)
 * and the group (multi-campus) screens — campuses, group dashboard, campus comparison, inter-campus transfers
 * and group policies. Figures are read-only aggregates over the other modules' tables; Finance's ledger,
 * Safety's incident counts and Transport's tracking settings are used through their exported services.
 */
@Module({
  imports: [FinanceModule, SafetyModule, TransportModule],
  controllers: [DashboardController, ReportsController, GroupController, TransfersController, PoliciesController],
  providers: [GuardedReadsService, CommandCenterService, OverviewService, GroupMetricsService, TransfersService, ReportsService, InsightsSearch],
  exports: [CommandCenterService, GroupMetricsService],
})
export class InsightsModule {}
