import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { AiProvider, ExamCorrectionConfig, Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { badRequest, fieldError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import type { AiPart } from '../ai/ai.providers';
import { AiService } from '../ai/ai.service';
import { EcAccess } from './ec.access';
import { EcAi } from './ec.ai.service';
import { EcAudit } from './ec.audit';
import { AiSettingsDto, TestQuery } from './ec.dto';
import { parseReading, READING_SYSTEM, readingIntro } from './ec.prompts';
import { renderer, SAMPLE, sampleImage, samplePdf } from './ec.render';
import { effortOf, nameCheck, visionProblem } from './ec.util';

const EFFORT_LIST = ['low', 'medium', 'high'];

interface TestResult { ok: boolean; target: string; detail: string; model?: string; duration_ms?: number; sample_text?: string; sample_name?: string | null }

/**
 * Settings › AI configuration for Paper Correction. Providers and their keys are managed on the AI Providers
 * page (Super Admin); here the administrator chooses which connected provider serves Paper Correction, sets
 * the module's options, acknowledges external processing and tests reading and marking.
 */
@Controller('exam-correction/api/settings/ai')
@RequirePermissions('settings.manage')
export class EcSettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: EcAccess,
    private readonly ai: AiService,
    private readonly ecAi: EcAi,
    private readonly audit: EcAudit,
  ) {}

  private async view() {
    const [{ cfg, provider }, providers] = await Promise.all([
      this.access.aiState(),
      this.prisma.aiProvider.findMany({ where: { isEnabled: true }, orderBy: { createdAt: 'asc' } }),
    ]);
    const label = (p: AiProvider) => `${p.label} — reading: ${p.visionModel || p.model}, marking: ${p.model}${p.purposes.includes('paper_correction') ? '' : p.isDefault ? ' (default)' : ''}`;
    const models = providers.length
      ? providers.map((p) => ({ id: p.id, label: label(p) }))
      : [{ id: '', label: 'No AI provider connected — a Super Admin adds one under Users & Settings › AI Providers' }];
    return {
      config: {
        claude_enabled: cfg.aiEnabled,
        // Never the key itself: the masked preview of the provider's key, managed on the AI Providers page.
        claude_api_key: provider?.keyPreview ?? null,
        claude_vision_model: provider?.id ?? '',
        claude_eval_model: provider?.id ?? '',
        claude_effort: cfg.effort,
        claude_timeout: cfg.timeoutSec,
        max_retries: cfg.maxRetries,
        claude_refusal_fallback: cfg.retryUnusable,
        external_processing_acknowledged: cfg.externalAck,
        external_processing_acknowledged_by: cfg.externalAck && cfg.externalAckByName ? { user: cfg.externalAckByName, at: cfg.externalAckAt?.toISOString() ?? '' } : null,
        redact_top_percent: cfg.redactTopPercent,
      },
      options: { models, efforts: EFFORT_LIST },
    };
  }

  @Get()
  async get() {
    return this.view();
  }

  @Put()
  async update(@Body() dto: AiSettingsDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const c = dto.changes ?? {};
    if (c.claude_api_key?.trim()) {
      throw fieldError('claude_api_key', 'API keys are not stored here. A Super Admin connects or updates the provider and its key under Users & Settings › AI Providers; Paper Correction uses the provider chosen on this page.');
    }
    const { cfg, provider } = await this.access.aiState();
    const changes: string[] = [];

    // Choosing a provider assigns the "Paper Correction" purpose to it (the same switch as on the AI Providers page).
    const current = provider?.id ?? '';
    const wanted = c.claude_vision_model && c.claude_vision_model !== current ? c.claude_vision_model : c.claude_eval_model && c.claude_eval_model !== current ? c.claude_eval_model : null;
    if (wanted) {
      const chosen = await this.prisma.aiProvider.findUnique({ where: { id: wanted } });
      if (!chosen?.isEnabled) throw fieldError('claude_vision_model', 'Choose a connected, enabled provider.');
      const others = await this.prisma.aiProvider.findMany({ where: { id: { not: chosen.id }, purposes: { has: 'paper_correction' } } });
      await this.prisma.$transaction([
        ...others.map((p) => this.prisma.aiProvider.update({ where: { id: p.id }, data: { purposes: p.purposes.filter((x) => x !== 'paper_correction') } })),
        this.prisma.aiProvider.update({ where: { id: chosen.id }, data: { purposes: [...new Set([...chosen.purposes, 'paper_correction'])] } }),
      ]);
      await this.audit.record(user, { action: 'update', entityType: 'ai_provider', entityId: chosen.id, description: `Paper Correction now uses ${chosen.label} (${chosen.visionModel || chosen.model} for reading, ${chosen.model} for marking)` }, req);
      changes.push(`provider → ${chosen.label}`);
    }

    const data: Prisma.ExamCorrectionConfigUpdateInput = {};
    if (c.claude_enabled !== undefined && c.claude_enabled !== cfg.aiEnabled) data.aiEnabled = c.claude_enabled;
    if (c.claude_effort && c.claude_effort !== cfg.effort) data.effort = c.claude_effort;
    if (c.claude_timeout !== undefined && c.claude_timeout !== cfg.timeoutSec) data.timeoutSec = c.claude_timeout;
    if (c.max_retries !== undefined && (c.max_retries ?? 2) !== cfg.maxRetries) data.maxRetries = c.max_retries ?? 2;
    if (c.claude_refusal_fallback !== undefined && c.claude_refusal_fallback !== cfg.retryUnusable) data.retryUnusable = c.claude_refusal_fallback;
    if (c.redact_top_percent !== undefined && (c.redact_top_percent ?? 0) !== cfg.redactTopPercent) data.redactTopPercent = c.redact_top_percent ?? 0;
    if (c.external_processing_acknowledged !== undefined && c.external_processing_acknowledged !== cfg.externalAck) {
      Object.assign(data, c.external_processing_acknowledged
        ? { externalAck: true, externalAckById: user.id, externalAckByName: user.fullName, externalAckAt: new Date() }
        : { externalAck: false, externalAckById: null, externalAckByName: null, externalAckAt: null });
    }
    if (Object.keys(data).length) {
      await this.prisma.examCorrectionConfig.update({ where: { id: 'default' }, data: { ...data, updatedById: user.id } });
      const labels: Record<string, string> = { aiEnabled: 'enabled', effort: 'effort', timeoutSec: 'timeout', maxRetries: 'retries', retryUnusable: 'retry unusable replies', redactTopPercent: 'blank top %', externalAck: 'external processing acknowledged' };
      for (const [k, v] of Object.entries(data)) if (labels[k]) changes.push(`${labels[k]} → ${String(v)}`);
      await this.audit.record(user, {
        action: 'update', entityType: 'exam_ai_settings', entityId: 'default',
        description: `Paper Correction AI configuration: ${changes.join('; ')}`, sensitive: data.externalAck !== undefined,
      }, req);
    }
    return ok(await this.view(), changes.length ? 'AI configuration saved' : 'No changes');
  }

  /** Tests marking (connection + a sample answer) or reading (a synthetic sample page — no student data). */
  @Post('test/:target')
  @HttpCode(200)
  async test(@Param('target') target: string, @Query() q: TestQuery, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (target !== 'reading' && target !== 'marking') throw badRequest('Test "reading" or "marking".');
    const { cfg, provider, pdfOk } = await this.access.aiState();
    if (!provider) return { ok: false, target, detail: 'No AI provider is connected. A Super Admin connects one under Users & Settings › AI Providers.' };
    const started = Date.now();
    const result = target === 'marking' ? await this.testMarking(provider, cfg) : await this.testReading(provider, cfg, pdfOk, q.sample === 'true');
    await this.audit.record(user, { action: 'update', entityType: 'exam_ai_settings', entityId: provider.id, description: `Tested Paper Correction ${target} with ${provider.label}: ${result.ok ? 'OK' : 'failed'}` }, req);
    return { ...result, duration_ms: result.duration_ms ?? Date.now() - started };
  }

  private async testMarking(provider: AiProvider, cfg: ExamCorrectionConfig): Promise<TestResult> {
    // AiService.test records the result on the provider (shown on the AI Providers page).
    const conn = await this.ai.test(provider.id);
    if (!conn.lastTestOk) return { ok: false, target: 'marking', detail: conn.lastTestMessage ?? 'The provider did not answer.', model: provider.model };
    try {
      const { marked, usage } = await this.ecAi.mark(
        {
          subject: 'Science', gradeLevel: '', className: 'Test', instructions: '',
          question: { number: '1', text: 'What is photosynthesis?', qtype: 'short', maxMarks: 2, markIncrement: 0.5, numericAnswer: null, unit: null },
          rubric: { version: 1, source: 'teacher', referenceAnswer: 'Plants make their own food (glucose) from carbon dioxide and water using light energy, giving out oxygen.', criteria: [{ id: 'C1', name: 'Plants make food / glucose', max_marks: 1 }, { id: 'C2', name: 'Uses light, water and carbon dioxide', max_marks: 1 }], expectedConcepts: ['food is made by the plant', 'light energy', 'carbon dioxide and water'], alternatives: [], misconceptions: ['plants take food from the soil'], partialCreditRules: '', requiredElements: '', ignoreCriteria: 'spelling', subjectRules: '' },
          answerText: SAMPLE.lines.slice(0, 3).join('\n'), withImages: false,
        },
        { numericTolerance: 0.01, ocrConfidence: null, images: [], maxTokens: effortOf(cfg.effort).markTokens },
        cfg,
      );
      if (!marked.valid) return { ok: false, target: 'marking', detail: `Connected, but the reply could not be used: ${marked.error}`, model: usage.model ?? provider.model };
      return { ok: true, target: 'marking', detail: `${conn.lastTestMessage}. A correct sample answer was marked ${marked.total}/2 (expected 2)${marked.total === 2 ? '' : ' — check the model'}`, model: usage.model ?? provider.model, duration_ms: usage.durationMs };
    } catch (err) {
      return { ok: false, target: 'marking', detail: (err as Error).message, model: provider.model };
    }
  }

  private async testReading(provider: AiProvider, cfg: ExamCorrectionConfig, pdfOk: boolean, sample: boolean): Promise<TestResult> {
    const model = provider.visionModel || provider.model;
    const vision = visionProblem(provider);
    if (vision) return { ok: false, target: 'reading', detail: vision, model };
    try {
      let part: AiPart;
      if (await renderer()) {
        const img = await sampleImage();
        part = { type: 'image', mediaType: img.mime, data: img.data.toString('base64') };
      } else if (pdfOk) {
        part = { type: 'pdf', data: (await samplePdf()).toString('base64') };
      } else {
        return { ok: false, target: 'reading', detail: 'This server cannot draw the sample page, and the provider reads images only.', model };
      }
      const intro = readingIntro({ examName: 'Connection test', subject: 'Science', className: 'Test', questions: [{ number: '1', text: 'What is photosynthesis?', maxMarks: 2 }, { number: '2', text: 'A car travels 60 km in 2 hours. Find its speed.', maxMarks: 2 }], pageNos: [1], totalPages: 1, carryQuestion: null, redactedFirstPage: false });
      const r = await this.ecAi.json({ system: READING_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: intro }, { type: 'text', text: 'Page 1:' }, part] }], maxTokens: 2000 }, { vision: true, temperature: 0, thinkingBudget: 512 }, cfg);
      const parsed = r.json ? parseReading(r.json, [1], ['1', '2']) : null;
      if (!parsed) return { ok: false, target: 'reading', detail: `The reading model answered, but not with a usable transcription: ${r.text.slice(0, 160)}`, model: r.model ?? model, duration_ms: r.durationMs };
      const text = parsed.pages.map((p) => p.text).join('\n\n');
      const found = parsed.segments.filter((s) => s.question).length;
      const name = nameCheck(parsed.nameOnSheet, SAMPLE.name);
      return {
        ok: true, target: 'reading', model: r.model ?? model, duration_ms: r.durationMs,
        detail: `Read the sample page: ${found} answer segment(s) found, name ${name.status === 'match' ? 'read correctly' : name.status === 'none' ? 'not read' : `read as "${parsed.nameOnSheet}"`}`,
        ...(sample ? { sample_text: text, sample_name: parsed.nameOnSheet } : {}),
      };
    } catch (err) {
      return { ok: false, target: 'reading', detail: (err as Error).message, model };
    }
  }
}
