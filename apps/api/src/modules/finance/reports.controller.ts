import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { FinanceReportsService, REPORTS } from './reports.service';

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

/** The standard financial reports (view, print, export to CSV on the page). */
@Controller('finance/reports')
@RequirePermissions('finance.read')
export class FinanceReportsController {
  constructor(
    private readonly reports: FinanceReportsService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  catalog() {
    return Object.entries(REPORTS).map(([key, r]) => ({ key, ...r }));
  }

  @Get(':key')
  async report(@Param('key') key: string, @Query() q: CampusQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const campusId = this.scope.campus(user, q.campusId);
    const r = await this.reports.generate(key, campusId);
    await this.audit.record({
      user, action: key === 'audit-pack' ? 'export' : 'view', module: 'finance', entityType: 'finance_report', entityId: key, campusId: campusId ?? null, req,
      description: `Generated ${r.title}${r.campus ? ` for ${r.campus}` : ''} (${r.rows.length} rows)`,
    });
    return r;
  }
}
