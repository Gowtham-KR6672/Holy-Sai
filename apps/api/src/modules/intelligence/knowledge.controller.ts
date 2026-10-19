import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../audit/audit.service';
import { dayKey, normalizeQuestion, truncate } from './intel.util';
import { KnowledgeLive } from './knowledge.live';
import { KnowledgeService, type Hit } from './knowledge.service';
import { IntelPeople } from './people.service';

class AskDto {
  @IsString() @MinLength(3, { message: 'Type a question of at least 3 characters' }) @MaxLength(300) question: string;
}

class FeedbackDto {
  @IsString() @MaxLength(300) question: string;
  @IsBoolean() helpful: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) documentIds?: string[];
  @IsOptional() @Type(() => Boolean) @IsBoolean() routeToPerson?: boolean;
}

export const KNOWLEDGE_SYSTEM =
  'You are Holy Sai Knowledge, the assistant of Holy Sai International School. Answer ONLY from the numbered excerpts of approved school ' +
  'documents provided. Never use outside knowledge and never guess names, dates, amounts or numbers that are not in the excerpts. If the ' +
  'excerpts do not answer the question, set found to false. Write plain, warm British English in at most two short paragraphs (under 120 ' +
  'words), separated by a blank line. Reply with JSON only: {"found": true|false, "answer": "…", "used": [excerpt numbers]}.';

/** School Knowledge AI: answers from approved documents and live records the asker may see. */
@Controller('knowledge')
@RequirePermissions('ai.use')
export class KnowledgeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
    private readonly knowledge: KnowledgeService,
    private readonly live: KnowledgeLive,
    private readonly people: IntelPeople,
  ) {}

  @Post('ask')
  @HttpCode(200)
  async ask(@Body() dto: AskDto, @Query('campusId') campusId: string | undefined, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const question = dto.question.trim().replace(/\s+/g, ' ');
    const campus = this.scope.campus(user, campusId);
    const result = await this.answer(user, question, campusId, campus);
    await this.prisma.knowledgeQuestion.create({
      data: {
        userId: user.id, roleKey: user.roleKey, channel: 'web', campusId: campus ?? null, question, normalized: normalizeQuestion(question),
        found: result.found, kind: result.kind, confidence: result.found ? result.confidence : null,
        sourceIds: result.sources.map((s) => s.id).filter((x): x is string => !!x),
      },
    });
    await this.audit.record({
      user, action: 'ask', module: 'knowledge', entityType: 'knowledge_question', campusId: campus ?? null, req, sensitive: result.usedRestricted,
      description: `Asked: “${truncate(question, 160)}” — ${result.found ? `${result.kind === 'live' ? 'live records' : `${result.sources.length} source(s)`}, ${result.confidence} confidence` : 'no answer found'}`,
      metadata: { sources: result.sources.map((s) => s.doc) },
    });
    const { usedRestricted: _ignored, ...out } = result;
    void _ignored;
    return ok(out, result.found ? 'Answer ready' : 'No approved source answers this');
  }

  private async answer(user: AuthUser, question: string, campusId: string | undefined, campus: string | undefined) {
    const base = { question, restricted: false as boolean, usedRestricted: false, matchedTerms: [] as string[], coverage: 0 as number | undefined, chart: undefined as { label: string; value: number }[] | undefined };
    const live = await this.live.answer(user, question, campusId);
    if (live) {
      return {
        ...base, found: live.found, kind: 'live' as const, answer: live.answer, confidence: live.confidence, restricted: !!live.restricted, chart: live.chart,
        sources: live.sources as { id: string | null; doc: string; section: string | null; updated: string | null; live?: boolean }[], excerpts: [] as { documentId: string; doc: string; section: string | null; text: string; matched: string[] }[],
        method: 'Computed directly from live school records you are allowed to see. No language model is involved.',
      };
    }

    const { hits, queryTerms, restrictedBetter, searched } = await this.knowledge.search(question, { kind: 'user', user, campusId: campus });
    const good = hits.filter((h) => h.coverage >= 0.5);
    const method = `Keyword search over ${searched} approved source${searched === 1 ? '' : 's'} you may read`;
    if (!good.length) {
      const { indexed } = await this.knowledge.counts();
      return {
        ...base, found: false, kind: 'documents' as const, confidence: 'Low' as const, restricted: restrictedBetter, sources: [], excerpts: [],
        answer: restrictedBetter
          ? 'The closest approved source is restricted to staff who already hold access to safeguarding and wellbeing records, so it cannot be used for your answer. Please ask the Designated Safeguarding Lead or the Principal.'
          : indexed
            ? 'No approved school document answers this yet. Try different words, or use “Ask a person instead” to send the question to the front office.'
            : 'No approved school documents have been shared with the assistant yet. Documents verified under Operations › Documents and released circulars become sources automatically.',
        method,
      };
    }

    const top = good.slice(0, 3);
    const matched = [...new Set(top.flatMap((h) => h.matched))];
    const coverage = matched.length / Math.max(1, queryTerms.length);
    let confidence: 'High' | 'Medium' | 'Low' = coverage >= 0.8 ? 'High' : coverage >= 0.6 ? 'Medium' : 'Low';
    let answer = '';
    let used: Hit[] = top;
    let how = 'answer quoted from the best-matching passages (no language model connected)';

    const status = await this.ai.status('knowledge');
    if (status.available) {
      try {
        const excerpts = top.map((h, i) => `[${i + 1}] ${h.title}${h.heading ? ` — ${h.heading}` : ''}\n${h.text}`).join('\n\n');
        const r = await this.ai.completeJson<{ found?: boolean; answer?: string; used?: number[] }>('knowledge', {
          system: KNOWLEDGE_SYSTEM,
          messages: [{ role: 'user', content: `Question: ${question}\n\nExcerpts:\n${excerpts}` }],
          maxTokens: 600,
          temperature: 0.1,
        });
        if (r.data.found === false || !r.data.answer?.trim()) {
          return {
            ...base, found: false, kind: 'documents' as const, confidence: 'Low' as const, sources: [], excerpts: [], matchedTerms: matched,
            answer: 'The approved documents mention these words but do not answer the question. Use “Ask a person instead” to send it to the front office.',
            method: `${method} · checked by ${status.label ?? status.provider} (${status.model})`,
          };
        }
        answer = r.data.answer.trim();
        const picked = (r.data.used ?? []).map((n) => top[n - 1]).filter((h): h is Hit => !!h);
        if (picked.length) used = picked;
        how = `answer written by ${status.label ?? status.provider} (${r.model}) from the excerpts shown`;
      } catch (err) {
        how = `answer quoted from the best-matching passages (the AI provider did not answer: ${truncate((err as Error).message, 80)})`;
      }
    }
    if (!answer) {
      answer = this.knowledge.extractive(top, queryTerms);
      if (!answer) {
        answer = truncate(top[0].text, 500);
        confidence = 'Low';
      }
    }
    const bySource = new Map<string, Hit>();
    for (const h of used) if (!bySource.has(h.sourceId)) bySource.set(h.sourceId, h);
    return {
      ...base, found: true, kind: 'documents' as const, answer, confidence, matchedTerms: matched, coverage: Math.round(coverage * 100),
      usedRestricted: used.some((h) => h.restricted),
      sources: [...bySource.values()].map((h) => ({ id: h.sourceId, doc: h.title, section: h.section, updated: h.updated })),
      excerpts: [...bySource.values()].map((h) => ({ documentId: h.sourceId, doc: h.title, section: h.heading ?? h.section, text: truncate(h.text, 900), matched: h.matched })),
      method: `${method} · ${how}`,
    };
  }

  @Get('sources')
  async sources(@Query('campusId') campusId: string | undefined, @CurrentUser() user: AuthUser) {
    const rows = await this.knowledge.sources({ kind: 'user', user, campusId: this.scope.campus(user, campusId) });
    return {
      documents: rows.map((s) => ({
        id: s.id, title: s.title, section: s.section, audience: s.audience, keywords: s.keywords, updated: dayKey(s.sourceUpdatedAt), restricted: s.restricted,
      })),
      live: this.live.sources(user),
    };
  }

  @Get('top-questions')
  async top() {
    const n = new Date(Date.now() + 330 * 60_000);
    const start = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1) - 330 * 60_000);
    const rows = await this.prisma.knowledgeQuestion.findMany({ where: { createdAt: { gte: start } }, select: { question: true, normalized: true }, orderBy: { createdAt: 'desc' } });
    const groups = new Map<string, { label: string; value: number }>();
    for (const r of rows) {
      const g = groups.get(r.normalized) ?? { label: r.question, value: 0 };
      g.value++;
      groups.set(r.normalized, g);
    }
    return [...groups.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)).slice(0, 6);
  }

  @Post('feedback')
  @HttpCode(200)
  async feedback(@Body() dto: FeedbackDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const question = dto.question.trim();
    const row = await this.prisma.knowledgeFeedback.create({
      data: { userId: user.id, question, helpful: dto.helpful, routeToPerson: !!dto.routeToPerson, documentIds: dto.documentIds ?? [] },
    });
    if (dto.routeToPerson) {
      const office = await this.people.frontOffice(user.campusId);
      await this.people.tasks(office, {
        title: `Answer a question from ${user.fullName}: “${truncate(question, 90)}”`, module: 'knowledge', priority: 'Medium', status: 'Pending',
        route: '/knowledge-ai', entityType: 'knowledge_feedback', entityId: row.id,
      });
      await this.people.notify(office, {
        category: 'Attention', topic: 'system', module: 'knowledge', icon: 'message', campusId: user.campusId,
        title: `Question for the front office from ${user.fullName}`, body: `“${truncate(question, 200)}” — the Knowledge AI had no complete answer. Reply to ${user.fullName} directly.`, route: '/knowledge-ai',
      });
    }
    await this.audit.record({
      user, action: 'create', module: 'knowledge', entityType: 'knowledge_feedback', entityId: row.id, req,
      description: dto.routeToPerson ? `Sent a Knowledge AI question to the front office: “${truncate(question, 120)}”` : `Rated a Knowledge AI answer ${dto.helpful ? 'helpful' : 'not helpful'}: “${truncate(question, 120)}”`,
    });
    return ok({ id: row.id }, dto.routeToPerson ? 'Sent to the front office' : 'Thanks — feedback recorded');
  }
}
