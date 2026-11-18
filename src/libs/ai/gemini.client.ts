import config from 'config/env';
import { NonRetryableError } from 'libs/jobs/runner';

/**
 * Minimal Gemini Interactions API client (REST, POST /v1beta/interactions).
 * Server-side only — the API key never leaves the backend.
 */

export type InteractionContent =
  | { type: 'text'; text: string; annotations?: Record<string, unknown>[] }
  | { type: 'image'; data: string; mime_type: string }
  | { type: 'file'; uri: string; mime_type: string }
  | { type: 'audio'; data: string; mime_type: string };

export interface UploadedFile {
  uri: string;
  name: string;
}

/** Derive the upload host: ".../v1beta" → ".../upload/v1beta". */
const uploadBase = () => `${new URL(config.GEMINI_API_BASE as string).origin}/upload/v1beta`;

/**
 * Gemini Files API resumable upload. Upload once, then reference the returned
 * URI in interactions instead of re-sending base64 bytes in every request.
 * Returns null on any failure — callers must fall back to inline data.
 */
export const uploadFile = async (buf: Buffer, mimeType: string, displayName: string, signal?: AbortSignal): Promise<UploadedFile | null> => {
  if (!config.GEMINI_API_KEY || config.GEMINI_FILES_API === 'false') return null;
  try {
    const start = await fetch(`${uploadBase()}/files`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': config.GEMINI_API_KEY as string,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(buf.length),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
      signal: signal || AbortSignal.timeout(60000),
    });
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!start.ok || !uploadUrl) return null;

    const up = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
        'Content-Type': mimeType,
        'Content-Length': String(buf.length),
      },
      body: buf as any,
      signal: signal || AbortSignal.timeout(120000),
    });
    const json: any = await up.json().catch(() => ({}));
    const file = json?.file;
    if (!up.ok || !file?.uri) return null;

    // Media may still be processing server-side — poll until ACTIVE.
    for (let i = 0; i < 8 && file.state === 'PROCESSING'; i++) {
      await sleep(1500, signal);
      const st = await fetch(`${config.GEMINI_API_BASE}/${file.name}`, {
        headers: { 'x-goog-api-key': config.GEMINI_API_KEY as string },
        signal: signal || AbortSignal.timeout(30000),
      });
      const sj: any = await st.json().catch(() => ({}));
      if (sj?.state === 'ACTIVE') break;
      if (sj?.state === 'FAILED') return null;
    }
    return { uri: file.uri, name: file.name };
  } catch {
    return null;
  }
};

export interface InteractionUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  outputByModality?: { modality: string; tokens: number }[];
}

export interface InteractionRequest {
  model: string;
  input: InteractionContent[] | string;
  systemInstruction?: string;
  /** JSON schema → structured output (response_format application/json) */
  schema?: Record<string, unknown>;
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  maxOutputTokens?: number;
  responseFormat?: Record<string, unknown>;
  generationConfig?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface InteractionResult {
  id?: string;
  text: string;
  json?: any;
  audio?: { data: string; mimeType?: string };
  usage: InteractionUsage;
  raw: any;
}

export class GeminiError extends Error {
  constructor(message: string, public status: number, public retryable: boolean) {
    super(message);
  }
}

export const geminiConfigured = () => !!config.GEMINI_API_KEY;

const assertKey = () => {
  if (!config.GEMINI_API_KEY) {
    throw new NonRetryableError('GEMINI_API_KEY is not configured on the server. Add it to the backend .env file.', 'AI_NOT_CONFIGURED');
  }
};

const parseUsage = (u: any): InteractionUsage => ({
  inputTokens: Number(u?.total_input_tokens || 0),
  outputTokens: Number(u?.total_output_tokens || 0),
  thoughtTokens: Number(u?.total_thought_tokens || 0),
  totalTokens: Number(u?.total_tokens || 0),
  outputByModality: u?.output_tokens_by_modality,
});

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });

export const geminiFetch = async (path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; query?: Record<string, string | string[]> }) => {
  assertKey();
  const url = new URL(`${config.GEMINI_API_BASE}${path}`);
  Object.entries(init.query || {}).forEach(([k, v]) => (Array.isArray(v) ? v : [v]).forEach((x) => url.searchParams.append(k, x)));
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(config.GEMINI_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method || 'POST',
        headers: {
          'x-goog-api-key': config.GEMINI_API_KEY as string,
          'Content-Type': 'application/json',
          'Api-Revision': config.GEMINI_API_REVISION as string,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal,
      });
    } catch (error: any) {
      if (init.signal?.aborted) throw error;
      if (attempt >= maxAttempts) throw new GeminiError(`Gemini request failed: ${error.message}`, 0, true);
      await sleep(1000 * 2 ** attempt, init.signal);
      continue;
    }
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) return json;

    const message = json?.error?.message || `Gemini API error ${res.status}`;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) {
      if (res.status === 401 || res.status === 403) {
        throw new NonRetryableError(`Gemini rejected the API key or the project lacks access: ${message}`, 'AI_AUTH');
      }
      throw new NonRetryableError(`Gemini request invalid (${res.status}): ${message}`, 'AI_BAD_REQUEST');
    }
    if (attempt >= maxAttempts) throw new GeminiError(message, res.status, true);
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt, init.signal);
  }
};

/** Collect output text / audio from the model_output steps of an Interaction. */
const collectOutput = (raw: any) => {
  let text = '';
  let audio: InteractionResult['audio'];
  for (const step of raw?.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const c of step.content || []) {
      if (c.type === 'text' && c.text) text += c.text;
      if (c.type === 'audio' && c.data) audio = { data: c.data, mimeType: c.mime_type };
    }
  }
  if (!text && typeof raw?.output_text === 'string') text = raw.output_text;
  if (!audio && raw?.output_audio?.data) audio = { data: raw.output_audio.data, mimeType: raw.output_audio.mime_type };
  return { text, audio };
};

export const createInteraction = async (req: InteractionRequest): Promise<InteractionResult> => {
  const body: Record<string, unknown> = {
    model: req.model,
    input: req.input,
    store: false,
    ...(req.systemInstruction ? { system_instruction: req.systemInstruction } : {}),
  };
  const generationConfig: Record<string, unknown> = { ...(req.generationConfig || {}) };
  if (req.thinkingLevel) generationConfig.thinking_level = req.thinkingLevel;
  if (req.maxOutputTokens) generationConfig.max_output_tokens = req.maxOutputTokens;
  if (Object.keys(generationConfig).length) body.generation_config = generationConfig;
  if (req.schema) body.response_format = { type: 'text', mime_type: 'application/json', schema: req.schema };
  else if (req.responseFormat) body.response_format = req.responseFormat;

  const raw = await geminiFetch('/interactions', { body, signal: req.signal });
  if (raw?.status && !['completed', 'incomplete'].includes(raw.status)) {
    throw new GeminiError(`Gemini interaction ended with status "${raw.status}"`, 200, raw.status !== 'failed');
  }
  const { text, audio } = collectOutput(raw);
  let json: any;
  if (req.schema) {
    try {
      json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      throw new GeminiError(`Gemini returned invalid JSON${raw?.status === 'incomplete' ? ' (output truncated)' : ''}`, 200, true);
    }
  }
  return { id: raw?.id, text, json, audio, usage: parseUsage(raw?.usage), raw };
};

/** Token count for budgeting (legacy countTokens endpoint, still supported). */
export const countTokens = async (model: string, text: string, signal?: AbortSignal): Promise<number> => {
  const json = await geminiFetch(`/models/${encodeURIComponent(model)}:countTokens`, {
    body: { contents: [{ role: 'user', parts: [{ text }] }] },
    signal,
  });
  return Number(json?.totalTokens || 0);
};
