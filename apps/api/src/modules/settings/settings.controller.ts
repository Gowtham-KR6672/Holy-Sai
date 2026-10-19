import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from './settings.service';

@Controller('settings')
@RequirePermissions('settings.manage')
export class SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list() {
    const rows = await this.prisma.setting.findMany({ orderBy: { key: 'asc' } });
    return rows.map((r) => ({ key: r.key, value: r.value, description: r.description, isPublic: r.isPublic, updatedAt: r.updatedAt.toISOString() }));
  }

  @Put(':key')
  async update(@Param('key') key: string, @Body() body: { value: unknown }, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { before, after } = await this.settings.update(key, body?.value, user.id);
    await this.audit.record({
      user,
      action: 'update',
      module: 'settings',
      entityType: 'setting',
      entityId: key,
      description: `Changed setting ${key}`,
      metadata: { before: before as never, after: after.value as never },
      req,
    });
    return ok({ key: after.key, value: after.value, description: after.description, isPublic: after.isPublic, updatedAt: after.updatedAt.toISOString() }, 'Setting saved');
  }
}
