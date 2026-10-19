import { Controller, Get, Query, Req } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { AuditService } from '../audit/audit.service';
import { AnalyticsService } from './analytics.service';
import { csvFile } from './intel.util';

class AreaQuery {
  @IsOptional() @IsString() area?: string;
  @IsOptional() @IsString() campusId?: string;
}

/** Flattens an area's chart data into rows: chart, label, measure, value. */
function flatten(data: Record<string, unknown>): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const [chart, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const label = String(o.label ?? '');
        for (const [k, val] of Object.entries(o)) if (k !== 'label' && (typeof val === 'number' || typeof val === 'string' || val === null)) rows.push({ chart, label, measure: k, value: val ?? '' });
      }
    } else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val !== 'object' || val === null) rows.push({ chart, label: '', measure: k, value: val ?? '' });
    } else if (v !== undefined) {
      rows.push({ chart, label: '', measure: 'value', value: v ?? '' });
    }
  }
  return rows;
}

/** Analytics by area, from the same live records the Command Center summarises. */
@Controller('analytics')
@RequirePermissions('reports.read')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  @Get('overview')
  async overview(@Query() q: AreaQuery, @CurrentUser() user: AuthUser) {
    const areas = this.analytics.areas(user);
    // The page renders the area it asked for, so an area outside the user's access is refused (not swapped).
    const area = q.area ?? 'students';
    const [data, scope] = await Promise.all([this.analytics.build(area, user, q.campusId), this.analytics.scopeLabel(user, q.campusId)]);
    return { area, areas, scope, generatedAt: new Date().toISOString(), data };
  }

  @Get('export')
  async export(@Query() q: AreaQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const area = q.area ?? 'students';
    const data = await this.analytics.build(area, user, q.campusId);
    const rows = flatten(data);
    await this.audit.record({ user, action: 'export', module: 'analytics', entityType: 'analytics_area', entityId: area, req, description: `Exported ${area} analytics (${rows.length} figures)` });
    return csvFile(`analytics-${area}.csv`, [
      { key: 'chart', label: 'Chart' }, { key: 'label', label: 'Label' }, { key: 'measure', label: 'Measure' }, { key: 'value', label: 'Value' },
    ], rows);
  }
}
