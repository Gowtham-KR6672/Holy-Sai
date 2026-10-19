import { Injectable } from '@nestjs/common';
import type { AiProvider } from '@prisma/client';
import { AI_PROVIDERS, type AiProviderId, type AiPurpose } from '@holysai/shared';
import { CryptoService } from '../../common/crypto.service';
import { AppError, unavailable } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AiRequest, AiResult, callProvider } from './ai.providers';

export function aiProviderDto(p: AiProvider) {
  return {
    id: p.id,
    provider: p.provider,
    label: p.label,
    model: p.model,
    visionModel: p.visionModel,
    baseUrl: p.baseUrl,
    keyPreview: p.keyPreview,
    isEnabled: p.isEnabled,
    isDefault: p.isDefault,
    purposes: p.purposes,
    timeoutSec: p.timeoutSec,
    maxRetries: p.maxRetries,
    lastTestedAt: p.lastTestedAt?.toISOString() ?? null,
    lastTestOk: p.lastTestOk,
    lastTestMessage: p.lastTestMessage,
  };
}

/** Per-call overrides of the provider's configured timeout and retry count (e.g. long vision calls). */
export interface AiCallOptions {
  vision?: boolean;
  timeoutMs?: number;
  /** Retries of temporary failures (rate limits, 5xx, timeouts); 0 = try once. */
  maxRetries?: number;
}

export interface AiCallResult extends AiResult {
  provider: string;
  model: string;
  durationMs: number;
}

/** Sends prompts to whichever connected provider serves a feature (Claude, Gemini, OpenAI, Groq or OpenRouter). */
@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** The provider for a feature: one assigned to it, else the default, else any enabled provider. */
  async providerFor(purpose: AiPurpose): Promise<AiProvider | null> {
    const enabled = await this.prisma.aiProvider.findMany({ where: { isEnabled: true }, orderBy: { createdAt: 'asc' } });
    return enabled.find((p) => p.purposes.includes(purpose)) ?? enabled.find((p) => p.isDefault) ?? enabled[0] ?? null;
  }

  async status(purpose: AiPurpose) {
    const p = await this.providerFor(purpose);
    return p
      ? { available: true, provider: p.provider, label: p.label, model: p.model, visionModel: p.visionModel ?? p.model }
      : { available: false, provider: null, label: null, model: null, visionModel: null };
  }

  async complete(purpose: AiPurpose, request: AiRequest, opts: AiCallOptions = {}): Promise<AiCallResult> {
    const provider = await this.providerFor(purpose);
    if (!provider) throw unavailable('No AI provider is connected. A Super Admin can connect Claude, Gemini, OpenAI, Groq or OpenRouter under Users & Settings › AI Providers.');
    return this.run(provider, request, opts);
  }

  /** Asks for JSON and parses the first JSON object or array in the reply. */
  async completeJson<T>(purpose: AiPurpose, request: AiRequest, opts: AiCallOptions = {}): Promise<{ data: T } & AiCallResult> {
    const result = await this.complete(purpose, { json: true, ...request }, opts);
    if (result.stopReason === 'max_tokens') {
      throw new AppError(502, 'AI_TRUNCATED', 'The AI reply was cut off before it finished. Try again with a shorter request or a higher reply limit.');
    }
    return { ...result, data: parseJson<T>(result.text) };
  }

  async run(provider: AiProvider, request: AiRequest, opts: AiCallOptions = {}): Promise<AiCallResult> {
    const def = AI_PROVIDERS.find((d) => d.id === provider.provider);
    const model = opts.vision && provider.visionModel ? provider.visionModel : provider.model;
    const started = Date.now();
    let lastErr: unknown;
    const retries = opts.maxRetries ?? provider.maxRetries;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await callProvider(
          { provider: provider.provider as AiProviderId, apiKey: this.crypto.decrypt(provider.apiKeyEnc), model, baseUrl: provider.baseUrl || def?.baseUrl || '' },
          request,
          opts.timeoutMs ?? provider.timeoutSec * 1000,
        );
        return { ...result, provider: provider.provider, model, durationMs: Date.now() - started };
      } catch (err) {
        lastErr = err;
        const msg = (err as Error).message;
        // Retry only temporary failures (rate limits, overload, timeouts, 5xx).
        if (!/^(429|5\d\d)\b|timeout|overloaded|ECONNRESET|fetch failed/i.test(msg)) break;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    throw new AppError(502, 'AI_PROVIDER_ERROR', `The AI provider (${provider.label}) did not answer: ${(lastErr as Error).message.slice(0, 240)}`);
  }

  /** Sends a tiny prompt and records whether the provider answered. */
  async test(id: string) {
    const provider = await this.prisma.aiProvider.findUniqueOrThrow({ where: { id } });
    let okFlag = true;
    let message: string;
    try {
      const r = await this.run({ ...provider, maxRetries: 0 }, { messages: [{ role: 'user', content: 'Reply with the single word: OK' }], maxTokens: 16 });
      message = `Connected · ${r.model} · ${r.durationMs} ms`;
    } catch (err) {
      okFlag = false;
      message = (err as Error).message.slice(0, 300);
    }
    const updated = await this.prisma.aiProvider.update({ where: { id }, data: { lastTestedAt: new Date(), lastTestOk: okFlag, lastTestMessage: message } });
    return aiProviderDto(updated);
  }
}

export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text.match(/([[{][\s\S]*[\]}])/)?.[1];
  if (!candidate) throw new AppError(502, 'AI_BAD_REPLY', 'The AI reply did not contain the expected data. Please try again.');
  try {
    return JSON.parse(candidate) as T;
  } catch {
    throw new AppError(502, 'AI_BAD_REPLY', 'The AI reply was not valid data. Please try again.');
  }
}
