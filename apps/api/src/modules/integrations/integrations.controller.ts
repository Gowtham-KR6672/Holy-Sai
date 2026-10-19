import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
import type { Request } from 'express';
import { INTEGRATION_FIELDS } from '@holysai/shared';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { badRequest } from '../../common/errors';
import { AuditService } from '../audit/audit.service';
import { IntegrationsService } from './integrations.service';

class SaveIntegrationDto {
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsBoolean() isEnabled?: boolean;
  @IsOptional() @IsObject() config?: Record<string, string>;
}

/** WhatsApp, SMS, email, payments, push, GPS, gates, biometrics, maps and storage. */
@Controller('admin/integrations')
@RequirePermissions('settings.manage')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list() {
    return { integrations: await this.integrations.list(), fields: INTEGRATION_FIELDS };
  }

  @Put(':kind')
  async save(@Param('kind') kind: string, @Body() dto: SaveIntegrationDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!this.integrations.isKind(kind)) throw badRequest('Unknown integration');
    const result = await this.integrations.save(kind, dto);
    await this.audit.record({ user, action: 'update', module: 'settings', entityType: 'integration', entityId: kind, description: `Updated ${result.label} integration`, req });
    return ok(result, `${result.label} settings saved`);
  }

  @Post(':kind/test')
  @HttpCode(200)
  async test(@Param('kind') kind: string) {
    if (!this.integrations.isKind(kind)) throw badRequest('Unknown integration');
    const r = await this.integrations.test(kind);
    return ok(r, r.status === 'ok' ? `${r.label}: connection works` : r.status === 'failed' ? `${r.label}: connection failed` : `${r.label} saved`);
  }
}
