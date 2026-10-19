import { Injectable } from '@nestjs/common';
import type { ExamCorrectionConfig } from '@prisma/client';
import { AppError } from '../../common/errors';
import type { AiMessage, AiPart, AiRequest } from '../ai/ai.providers';
import { AiService } from '../ai/ai.service';
import {
  blankMarking, MARKING_SYSTEM, markingPrompt, normalizeMarking, PAPER_SYSTEM, parsePaper, parseRubric, RUBRIC_SYSTEM, rubricPrompt,
  type MarkedAnswer, type MarkingContext, type RubricContext,
} from './ec.prompts';
import { estimateCostUsd, extractJson, replyCap } from './ec.util';

export interface Usage { provider: string; model: string | null; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number }
export interface JsonReply extends Usage { json: Record<string, unknown> | null; text: string }

/** What a call is for: reading pages (vision), marking (deterministic), drafting or reading a paper. */
export interface CallKind {
  vision: boolean;
  /** 0 for marking and transcription (consistent results); omitted = the model's default. */
  temperature?: number;
  /** Gemini 2.5+/3 thinking budget (added on top of the reply budget). */
  thinkingBudget?: number;
}

const RETRY_NOTE = 'Your previous reply could not be used. Reply again with only the JSON object in exactly the requested shape — no other text.';
/** Vision calls (several handwritten pages) need longer than the provider's default request timeout. */
const VISION_TIMEOUT_MS = 300_000;

/**
 * Every AI call of Paper Correction goes through AiService with the purpose "paper_correction"
 * (vision for reading pages). This class sets the per-call time limit and retries, asks for JSON, doubles
 * the reply budget when a reply is cut off (stopReason "max_tokens"), re-asks once with a stricter
 * instruction when a reply is unusable, and accounts tokens and cost.
 */
@Injectable()
export class EcAi {
  constructor(private readonly ai: AiService) {}

  async json(req: AiRequest, kind: CallKind | boolean, cfg: Pick<ExamCorrectionConfig, 'timeoutSec' | 'retryUnusable'>): Promise<JsonReply> {
    const k: CallKind = typeof kind === 'boolean' ? { vision: kind } : kind;
    const provider = (await this.ai.providerFor('paper_correction'))?.provider;
    const opts = {
      vision: k.vision,
      timeoutMs: cfg.timeoutSec ? cfg.timeoutSec * 1000 : k.vision ? VISION_TIMEOUT_MS : undefined,
      // Long vision calls: one quick retry here; the sheet job has its own retries with back-off.
      maxRetries: k.vision ? 1 : undefined,
    };
    const cap = replyCap(provider);
    let maxTokens = Math.min(cap, (req.maxTokens ?? 1024) + (provider === 'gemini' ? k.thinkingBudget ?? 0 : 0));
    const base: AiRequest = { ...req, json: true, imageDetail: 'high', ...(k.temperature !== undefined ? { temperature: k.temperature } : {}), ...(k.thinkingBudget !== undefined ? { thinkingBudget: k.thinkingBudget } : {}) };
    const started = Date.now();
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const call = async (r: AiRequest) => {
      for (;;) {
        const res = await this.ai.complete('paper_correction', { ...r, maxTokens }, opts);
        usage.inputTokens += res.inputTokens ?? 0;
        usage.outputTokens += res.outputTokens ?? 0;
        usage.costUsd += estimateCostUsd(res.model, res.inputTokens, res.outputTokens);
        if (res.stopReason !== 'max_tokens') return res;
        // Cut off: ask again with a bigger reply budget instead of re-asking as is.
        const next = Math.min(cap, maxTokens * 2);
        if (next <= maxTokens) throw new AppError(502, 'AI_TRUNCATED', `The AI reply was cut off at ${maxTokens} tokens, the most this provider allows.`);
        maxTokens = next;
      }
    };
    const first = await call(base);
    let text = first.text;
    let json = extractJson<Record<string, unknown>>(text);
    if (!json && cfg.retryUnusable) {
      const messages: AiMessage[] = [...req.messages, { role: 'assistant', content: text.trim().slice(0, 4000) || '(no reply)' }, { role: 'user', content: RETRY_NOTE }];
      text = (await call({ ...base, messages })).text;
      json = extractJson<Record<string, unknown>>(text);
    }
    return { json, text, provider: first.provider, model: first.model, ...usage, durationMs: Date.now() - started };
  }

  /** Marks one answer. Blank answers are marked by code (zero) without calling the AI. */
  async mark(ctx: MarkingContext, extra: { numericTolerance: number; ocrConfidence: number | null; images: AiPart[]; maxTokens: number }, cfg: ExamCorrectionConfig): Promise<{ marked: MarkedAnswer; usage: Usage }> {
    const crit = { criteria: ctx.rubric.criteria, maxMarks: ctx.question.maxMarks, markIncrement: ctx.question.markIncrement, answerText: ctx.answerText, numericAnswer: ctx.question.numericAnswer, numericTolerance: extra.numericTolerance, unit: ctx.question.unit, rubricSource: ctx.rubric.source, ocrConfidence: extra.ocrConfidence };
    if (!ctx.answerText.replace(/\[\?\]/g, '').trim()) {
      return { marked: blankMarking(ctx.rubric.criteria, ctx.question.maxMarks), usage: { provider: 'rules', model: null, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 } };
    }
    const prompt = markingPrompt({ ...ctx, withImages: extra.images.length > 0 });
    const content: AiPart[] | string = extra.images.length ? [{ type: 'text', text: prompt }, ...extra.images] : prompt;
    const r = await this.json({ system: MARKING_SYSTEM, messages: [{ role: 'user', content }], maxTokens: extra.maxTokens }, { vision: extra.images.length > 0, temperature: 0, thinkingBudget: 1024 }, cfg);
    const marked = r.json ? normalizeMarking(r.json, crit) : { ...normalizeMarking({}, crit), error: 'The AI reply was not valid data.' };
    return { marked, usage: r };
  }

  async draftRubric(ctx: RubricContext, maxTokens: number, cfg: ExamCorrectionConfig) {
    const r = await this.json({ system: RUBRIC_SYSTEM, messages: [{ role: 'user', content: rubricPrompt(ctx) }], maxTokens }, { vision: false, thinkingBudget: 1024 }, cfg);
    const rubric = r.json ? parseRubric(r.json, ctx.question.maxMarks, ctx.question.markIncrement) : null;
    if (!rubric) throw new AppError(502, 'AI_BAD_REPLY', 'The AI did not return a usable rubric. Please try again.');
    return { rubric, usage: r as Usage };
  }

  async readPaper(intro: string, parts: AiPart[], maxTokens: number, cfg: ExamCorrectionConfig) {
    const content: AiPart[] = [{ type: 'text', text: intro }, ...parts.flatMap((p, i) => [{ type: 'text' as const, text: `Page ${i + 1}:` }, p])];
    const r = await this.json({ system: PAPER_SYSTEM, messages: [{ role: 'user', content }], maxTokens }, { vision: true, temperature: 0, thinkingBudget: 512 }, cfg);
    const paper = r.json ? parsePaper(r.json) : null;
    if (!paper) throw new AppError(502, 'AI_BAD_REPLY', 'The AI could not list the questions on this paper. Check the pages are clear and try again.');
    return { paper, usage: r as Usage };
  }
}
