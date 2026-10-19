import { Controller, Get, Param, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ListQuery } from '../../common/paging';
import { AuditService } from '../audit/audit.service';
import { ReportsService } from './reports.service';

class ReportFilterQuery {
  @IsOptional() @IsString() campusId?: string;
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

class PreviewQuery extends ListQuery {
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

/**
 * Standard reports: GET /reports/catalog (what this role may run), GET /reports/:key/preview (one page of the
 * report on screen) and GET /reports/:key/export (the same report as CSV). Every export is audited.
 */
@Controller('reports')
@RequirePermissions('reports.read', 'users.manage')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
  ) {}

  @Get('catalog')
  catalog(@CurrentUser() user: AuthUser) {
    return this.reports.catalog(user);
  }

  @Get(':key/preview')
  async preview(@Param('key') key: string, @Query() q: PreviewQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { def, ctx, built } = await this.reports.run(user, key, q);
    if (built.sensitive && (q.page ?? 1) === 1 && !q.q) {
      await this.audit.record({
        user, action: 'view', module: 'reports', entityType: 'report', entityId: key, campusId: ctx.campusId ?? null, sensitive: true, req,
        description: `Viewed ${def.title} (${built.rows.length} rows)`,
      });
    }
    return this.reports.preview(def, built, q);
  }

  @Get(':key/export')
  async export(
    @Param('key') key: string, @Query() q: ReportFilterQuery, @CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { def, ctx, built } = await this.reports.run(user, key, q);
    const csv = this.reports.csv(built);
    const scope = ctx.campusId ? ctx.campusNames.get(ctx.campusId) ?? 'one campus' : 'all campuses';
    const window = def.filters.includes('date') ? ` for ${ctx.date}` : def.filters.includes('range') ? ` from ${ctx.from} to ${ctx.to}` : '';
    await this.audit.record({
      user, action: 'export', module: 'reports', entityType: 'report', entityId: key, campusId: ctx.campusId ?? null, sensitive: !!built.sensitive, req,
      description: `Exported ${def.title}${window} · ${scope} (${built.rows.length} rows${built.truncated ? ', truncated' : ''})`,
      metadata: { report: key, rows: built.rows.length, campus: scope, ...(def.filters.length ? { from: ctx.from, to: ctx.to, date: ctx.date } : {}) },
    });
    const name = ReportsService.fileName(key);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from(csv, 'utf8'));
  }
}
