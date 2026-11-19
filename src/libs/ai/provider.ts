import { Types } from 'mongoose';
import config from 'config/env';
import UsageRecord from 'models/usage-record.model';
import ProcessingJob from 'models/processing-job.model';
import { getPrice, tokenCost } from 'libs/pricing/pricing.service';

/**
 * Vision-language provider abstraction. All generation routes through the
 * Python ai-service (/generate-json) — backends: STORY_LLM_KIND=freegemini →
 * free-gemini-api proxy (Gemini web sessions), 'openai' → OpenAI-compatible
 * endpoint, else the local ONNX VLM. No paid API path exists in this codebase.
 */
export interface InteractionUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

export interface VisionImage {
  data: Buffer;
  mimeType: string;
  /** Short label placed before the image so the model can refer to it */
  label?: string;
}

export interface JsonRequest {
  system: string;
  prompt: string;
  images?: VisionImage[];
  schema: Record<string, unknown>;
  kind: 'vision' | 'text';
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Retries/fallbacks/provider errors are reported here so jobs can surface them */
  onLog?: (message: string, level?: 'info' | 'warn' | 'error') => void | Promise<void>;
}

export interface JsonResult<T> {
  data: T;
  usage: InteractionUsage;
  model: string;
  provider: string;
}

export interface VisionLanguageProvider {
  readonly name: string;
  readonly configured: boolean;
  modelFor(kind: 'vision' | 'text'): string;
  generateJson<T>(req: JsonRequest): Promise<JsonResult<T>>;
}

/**
 * Routes generation to the Python ai-service `/generate-json`, which in turn
 * calls the configured backend (free-gemini-api proxy by default). Free: no
 * cloud API key, no Files API.
 */
class LocalVisionProvider implements VisionLanguageProvider {
  readonly name = 'local';
  get configured() {
    return !!config.PANEL_DETECT_URL;
  }
  modelFor() {
    if (config.STORY_LLM_KIND === 'freegemini' && config.STORY_LLM_BASE_URL) return `${config.STORY_LLM_MODEL || 'hydrogen'}@freegemini`;
    return config.LOCAL_STORY_MODEL || 'local-llm';
  }
  async generateJson<T>(req: JsonRequest): Promise<JsonResult<T>> {
    const base = (config.PANEL_DETECT_URL || 'http://127.0.0.1:8003').replace(/\/+$/, '');
    const ac = new AbortController();
    const timer = config.STORY_LLM_TIMEOUT_MS > 0 ? setTimeout(() => ac.abort(), config.STORY_LLM_TIMEOUT_MS) : undefined;
    const onAbort = () => ac.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(`${base}/generate-json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          system: req.system,
          prompt: req.prompt,
          schema: req.schema,
          images: (req.images || []).map((i) => ({ data: i.data.toString('base64'), mimeType: i.mimeType, label: i.label })),
        }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = body?.detail || `Local AI service error ${res.status}`;
        const err: any = new Error(msg);
        err.retryable = res.status >= 500 || res.status === 503;
        throw err;
      }
      return {
        data: body.data as T,
        usage: { inputTokens: body.usage?.inputTokens || 0, outputTokens: body.usage?.outputTokens || 0, thoughtTokens: 0, totalTokens: (body.usage?.inputTokens || 0) + (body.usage?.outputTokens || 0) },
        model: body.model || this.modelFor(),
        provider: this.name,
      };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }
}

const localProvider = new LocalVisionProvider();

/** The only provider — accepts legacy 'gemini'/'local' names so stored settings can't break. */
export const getVisionProvider = (_name?: string): VisionLanguageProvider => localProvider;

/** Persist actual usage reported by the provider, priced with the active price list. */
export const recordUsage = async (opts: {
  owner: Types.ObjectId | string;
  project?: Types.ObjectId | string;
  job?: Types.ObjectId | string;
  provider: string;
  model: string;
  kind: 'vision' | 'text' | 'tts' | 'voice';
  usage: InteractionUsage;
  audioSeconds?: number;
  estimate?: Types.ObjectId | string;
}) => {
  const price = await getPrice(opts.provider, opts.model);
  // jobs started from an approved estimate carry its id → estimated vs actual comparison
  const estimate = opts.estimate || (opts.job ? (await ProcessingJob.findById(opts.job).select('payload'))?.payload?.estimateId : undefined);
  // thinking tokens are billed as output tokens
  const output = opts.usage.outputTokens + (opts.kind === 'tts' ? 0 : opts.usage.thoughtTokens);
  const costUSD = price ? tokenCost(price, opts.usage.inputTokens, output) : 0;
  return UsageRecord.create({
    owner: opts.owner,
    project: opts.project,
    job: opts.job,
    provider: opts.provider,
    modelId: opts.model,
    kind: opts.kind,
    inputTokens: opts.usage.inputTokens,
    outputTokens: opts.usage.outputTokens,
    thoughtTokens: opts.usage.thoughtTokens,
    audioSeconds: opts.audioSeconds,
    costUSD,
    pricingVersion: price?.version,
    estimate,
  });
};
