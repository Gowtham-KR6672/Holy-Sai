import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AI_PROVIDERS, AI_PURPOSES } from '@holysai/shared';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { CryptoService } from '../../common/crypto.service';
import { ok } from '../../common/envelope';
import { notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AiService, aiProviderDto } from './ai.service';

const PROVIDER_IDS = AI_PROVIDERS.map((p) => p.id) as string[];
const PURPOSE_IDS = AI_PURPOSES.map((p) => p.id) as string[];

class CreateProviderDto {
  @IsIn(PROVIDER_IDS) provider: string;
  @IsOptional() @IsString() @MaxLength(80) label?: string;
  @IsString() @MinLength(8) @MaxLength(400) apiKey: string;
  @IsOptional() @IsString() @MaxLength(120) model?: string;
  @IsOptional() @IsString() @MaxLength(120) visionModel?: string;
  @IsOptional() @IsString() @MaxLength(300) baseUrl?: string;
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(PURPOSE_IDS, { each: true }) purposes?: string[];
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsInt() @Min(10) @Max(900) timeoutSec?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5) maxRetries?: number;
}

class UpdateProviderDto {
  @IsOptional() @IsString() @MaxLength(80) label?: string;
  @IsOptional() @IsString() @MaxLength(400) apiKey?: string;
  @IsOptional() @IsString() @MaxLength(120) model?: string;
  @IsOptional() @IsString() @MaxLength(120) visionModel?: string;
  @IsOptional() @IsString() @MaxLength(300) baseUrl?: string;
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(PURPOSE_IDS, { each: true }) purposes?: string[];
  @IsOptional() @IsBoolean() isEnabled?: boolean;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsInt() @Min(10) @Max(900) timeoutSec?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5) maxRetries?: number;
}

/** Super Admin connects AI providers (Claude, Gemini, OpenAI, Groq, OpenRouter) and assigns them to features. */
@Controller('admin/ai-providers')
@RequirePermissions('settings.manage')
export class AiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list() {
    const rows = await this.prisma.aiProvider.findMany({ orderBy: { createdAt: 'asc' } });
    const coverage: Record<string, string | null> = {};
    for (const p of AI_PURPOSES) coverage[p.id] = (await this.ai.providerFor(p.id))?.id ?? null;
    return {
      providers: rows.map(aiProviderDto),
      coverage,
      catalog: AI_PROVIDERS.map((p) => ({ id: p.id, label: p.label, defaultModel: p.defaultModel, baseUrl: p.baseUrl })),
      purposes: AI_PURPOSES,
    };
  }

  @Post()
  async create(@Body() dto: CreateProviderDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const def = AI_PROVIDERS.find((p) => p.id === dto.provider)!;
    const makeDefault = dto.isDefault || (await this.prisma.aiProvider.count()) === 0;
    if (makeDefault) await this.prisma.aiProvider.updateMany({ data: { isDefault: false } });
    const key = dto.apiKey.trim();
    const row = await this.prisma.aiProvider.create({
      data: {
        provider: dto.provider,
        label: dto.label?.trim() || def.label,
        model: dto.model?.trim() || def.defaultModel,
        visionModel: dto.visionModel?.trim() || null,
        baseUrl: dto.baseUrl?.trim() || null,
        apiKeyEnc: this.crypto.encrypt(key),
        keyPreview: this.crypto.preview(key),
        purposes: dto.purposes ?? [],
        isDefault: makeDefault,
        timeoutSec: dto.timeoutSec ?? 120,
        maxRetries: dto.maxRetries ?? 2,
      },
    });
    await this.audit.record({ user, action: 'create', module: 'settings', entityType: 'ai_provider', entityId: row.id, description: `Connected AI provider ${row.label} (${row.model})`, req });
    const tested = await this.ai.test(row.id);
    return ok(tested, tested.lastTestOk ? `${row.label} connected` : `${row.label} saved, but the connection test failed`);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateProviderDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const existing = await this.prisma.aiProvider.findUnique({ where: { id } });
    if (!existing) throw notFound('AI provider');
    if (dto.isDefault) await this.prisma.aiProvider.updateMany({ where: { NOT: { id } }, data: { isDefault: false } });
    const key = dto.apiKey?.trim();
    const row = await this.prisma.aiProvider.update({
      where: { id },
      data: {
        ...(dto.label ? { label: dto.label.trim() } : {}),
        ...(dto.model ? { model: dto.model.trim() } : {}),
        ...(dto.visionModel !== undefined ? { visionModel: dto.visionModel.trim() || null } : {}),
        ...(dto.baseUrl !== undefined ? { baseUrl: dto.baseUrl.trim() || null } : {}),
        ...(dto.purposes ? { purposes: dto.purposes } : {}),
        ...(dto.isEnabled !== undefined ? { isEnabled: dto.isEnabled } : {}),
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        ...(dto.timeoutSec !== undefined ? { timeoutSec: dto.timeoutSec } : {}),
        ...(dto.maxRetries !== undefined ? { maxRetries: dto.maxRetries } : {}),
        ...(key ? { apiKeyEnc: this.crypto.encrypt(key), keyPreview: this.crypto.preview(key), lastTestOk: null, lastTestMessage: null } : {}),
      },
    });
    await this.audit.record({ user, action: 'update', module: 'settings', entityType: 'ai_provider', entityId: id, description: `Updated AI provider ${row.label}${key ? ' (new API key)' : ''}`, req });
    return ok(key ? await this.ai.test(id) : aiProviderDto(row), 'AI provider saved');
  }

  @Post(':id/test')
  @HttpCode(200)
  async test(@Param('id') id: string) {
    if (!(await this.prisma.aiProvider.findUnique({ where: { id } }))) throw notFound('AI provider');
    const r = await this.ai.test(id);
    return ok(r, r.lastTestOk ? 'Connection works' : 'Connection test failed');
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const existing = await this.prisma.aiProvider.findUnique({ where: { id } });
    if (!existing) throw notFound('AI provider');
    await this.prisma.aiProvider.delete({ where: { id } });
    if (existing.isDefault) {
      const next = await this.prisma.aiProvider.findFirst({ where: { isEnabled: true }, orderBy: { createdAt: 'asc' } });
      if (next) await this.prisma.aiProvider.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    await this.audit.record({ user, action: 'delete', module: 'settings', entityType: 'ai_provider', entityId: id, description: `Removed AI provider ${existing.label}`, req });
    return ok(null, `${existing.label} removed`);
  }
}
