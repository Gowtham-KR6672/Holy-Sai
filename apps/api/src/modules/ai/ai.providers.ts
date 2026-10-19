// HTTP adapters for each AI provider. All return plain text; callers ask for JSON in the prompt when they need it.
import type { AiProviderId } from '@holysai/shared';

export type AiPart =
  | { type: 'text'; text: string }
  /** Base64 image (JPEG, PNG, WebP), e.g. a scanned answer sheet. */
  | { type: 'image'; mediaType: string; data: string }
  /** Base64 PDF (Claude and Gemini read these natively). */
  | { type: 'pdf'; data: string };

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string | AiPart[];
}

export interface AiRequest {
  system?: string;
  messages: AiMessage[];
  maxTokens?: number;
  /** Ignored by models that reject it (OpenAI o-series / GPT-5). */
  temperature?: number;
  /** Ask for a JSON reply where the provider supports it natively (Gemini JSON mode). completeJson() sets this. */
  json?: boolean;
  /** Image detail for OpenAI-compatible vision calls; handwriting needs 'high' (the default). */
  imageDetail?: 'low' | 'high' | 'auto';
  /** Gemini 2.5+ thinking budget in tokens (0 turns thinking off where the model allows), so thinking cannot use up the reply. */
  thinkingBudget?: number;
}

export interface AiCallConfig {
  provider: AiProviderId;
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface AiResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Why generation stopped: 'max_tokens' means the reply was cut off (raise maxTokens rather than retrying as is). */
  stopReason: 'end' | 'max_tokens' | 'refused' | 'other' | null;
}

const stopOf = (raw: unknown): AiResult['stopReason'] => {
  if (raw == null) return null;
  const r = String(raw).toLowerCase();
  if (['end_turn', 'stop', 'stop_sequence', 'tool_use', 'tool_calls', 'end'].includes(r)) return 'end';
  if (['max_tokens', 'length', 'model_context_window_exceeded'].includes(r)) return 'max_tokens';
  if (['refusal', 'content_filter', 'safety', 'recitation', 'prohibited_content', 'blocklist', 'spii'].includes(r)) return 'refused';
  return 'other';
};

/** OpenAI reasoning models (o1/o3/o4…, GPT-5) take max_completion_tokens and reject temperature. */
const isReasoningModel = (model: string) => /(^|\/)(o\d|gpt-5)/i.test(model);

const parts = (c: string | AiPart[]): AiPart[] => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.message ?? text.slice(0, 300) ?? res.statusText;
    throw new Error(`${res.status} ${msg}`);
  }
  return json;
}

async function claude(cfg: AiCallConfig, req: AiRequest, timeoutMs: number): Promise<AiResult> {
  const body = {
    model: cfg.model,
    max_tokens: req.maxTokens ?? 1024,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.system ? { system: req.system } : {}),
    messages: req.messages.map((m) => ({
      role: m.role,
      content: parts(m.content).map((p) =>
        p.type === 'text'
          ? { type: 'text', text: p.text }
          : p.type === 'image'
            ? { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }
            : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } },
      ),
    })),
  };
  const json = await post(`${cfg.baseUrl.replace(/\/$/, '')}/v1/messages`, { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }, body, timeoutMs);
  const text = (json?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  return { text, inputTokens: json?.usage?.input_tokens ?? null, outputTokens: json?.usage?.output_tokens ?? null, stopReason: stopOf(json?.stop_reason) };
}

async function openAiCompatible(cfg: AiCallConfig, req: AiRequest, timeoutMs: number): Promise<AiResult> {
  const messages: any[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    messages.push({
      role: m.role,
      content: m.content.map((p) => {
        if (p.type === 'text') return { type: 'text', text: p.text };
        if (p.type === 'image') return { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}`, detail: req.imageDetail ?? 'high' } };
        return { type: 'file', file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${p.data}` } };
      }),
    });
  }
  const reasoning = isReasoningModel(cfg.model);
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.apiKey}` };
  if (cfg.provider === 'openrouter') {
    headers['http-referer'] = 'https://holysai.edu';
    headers['x-title'] = 'Holy Sai Smart School 360';
  }
  const json = await post(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, headers, {
    model: cfg.model,
    messages,
    // OpenAI's own API takes max_completion_tokens for every current model; Groq and OpenRouter take max_tokens.
    ...(cfg.provider === 'openai' || reasoning ? { max_completion_tokens: req.maxTokens ?? 1024 } : { max_tokens: req.maxTokens ?? 1024 }),
    ...(req.temperature !== undefined && !reasoning ? { temperature: req.temperature } : {}),
  }, timeoutMs);
  const content = json?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((c: any) => c.text ?? '').join('') : (content ?? '');
  return { text, inputTokens: json?.usage?.prompt_tokens ?? null, outputTokens: json?.usage?.completion_tokens ?? null, stopReason: stopOf(json?.choices?.[0]?.finish_reason) };
}

async function gemini(cfg: AiCallConfig, req: AiRequest, timeoutMs: number): Promise<AiResult> {
  const body = {
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    contents: req.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: parts(m.content).map((p) =>
        p.type === 'text'
          ? { text: p.text }
          : p.type === 'image'
            ? { inline_data: { mime_type: p.mediaType, data: p.data } }
            : { inline_data: { mime_type: 'application/pdf', data: p.data } },
      ),
    })),
    generationConfig: {
      maxOutputTokens: req.maxTokens ?? 1024,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.json ? { responseMimeType: 'application/json' } : {}),
      ...(req.thinkingBudget !== undefined && /gemini-(2\.5|[3-9])/i.test(cfg.model) ? { thinkingConfig: { thinkingBudget: req.thinkingBudget } } : {}),
    },
  };
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
  const json = await post(url, { 'x-goog-api-key': cfg.apiKey }, body, timeoutMs);
  const text = (json?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
  return { text, inputTokens: json?.usageMetadata?.promptTokenCount ?? null, outputTokens: json?.usageMetadata?.candidatesTokenCount ?? null, stopReason: stopOf(json?.candidates?.[0]?.finishReason) };
}

export function callProvider(cfg: AiCallConfig, req: AiRequest, timeoutMs = 120_000): Promise<AiResult> {
  switch (cfg.provider) {
    case 'claude':
      return claude(cfg, req, timeoutMs);
    case 'gemini':
      return gemini(cfg, req, timeoutMs);
    case 'openai':
    case 'groq':
    case 'openrouter':
      return openAiCompatible(cfg, req, timeoutMs);
    default:
      throw new Error(`Unknown AI provider ${cfg.provider as string}`);
  }
}
