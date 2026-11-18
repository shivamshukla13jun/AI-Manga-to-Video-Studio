import { Types } from 'mongoose';
import config from 'config/env';
import UsageRecord from 'models/usage-record.model';
import ProcessingJob from 'models/processing-job.model';
import { getPrice, tokenCost } from 'libs/pricing/pricing.service';
import { createInteraction, geminiConfigured, InteractionContent, InteractionUsage } from './gemini.client';

/**
 * Vision-language provider abstraction. Gemini is implemented; other
 * providers (Claude, open-weight VLMs behind an HTTP API) plug in by
 * implementing this interface and registering in `getVisionProvider`.
 */
export interface VisionImage {
  data: Buffer;
  mimeType: string;
  /** Files API URI — when set, the image is referenced by URI instead of inline base64 */
  uri?: string;
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

class GeminiVisionProvider implements VisionLanguageProvider {
  readonly name = 'gemini';
  /** Set when the API rejects file-URI input — we fall back to inline base64 for the rest of the process. */
  private fileUrisBroken = false;
  get configured() {
    return geminiConfigured();
  }
  modelFor(kind: 'vision' | 'text') {
    return this.modelsFor(kind)[0];
  }
  /** Ordered fallback chain for the kind — first model wins, next tried on rate limits */
  private modelsFor(kind: 'vision' | 'text'): string[] {
    const list = (kind === 'vision' ? config.GEMINI_VISION_MODELS : config.GEMINI_STORY_MODELS) as string;
    return list.split(',').map((m) => m.trim()).filter(Boolean);
  }
  async generateJson<T>(req: JsonRequest): Promise<JsonResult<T>> {
    const models = this.modelsFor(req.kind);
    const buildInput = (useFiles: boolean): InteractionContent[] => {
      const input: InteractionContent[] = [{ type: 'text', text: req.prompt }];
      for (const img of req.images || []) {
        if (img.label) input.push({ type: 'text', text: img.label });
        input.push(
          useFiles && img.uri
            ? { type: 'file', uri: img.uri, mime_type: img.mimeType }
            : { type: 'image', data: img.data.toString('base64'), mime_type: img.mimeType }
        );
      }
      return input;
    };
    const call = (useFiles: boolean) =>
      createInteraction({
        model: models,
        input: buildInput(useFiles),
        systemInstruction: req.system,
        schema: req.schema,
        thinkingLevel: config.GEMINI_THINKING_LEVEL as any,
        maxOutputTokens: req.maxOutputTokens,
        signal: req.signal,
      });
    const canUseFiles = !this.fileUrisBroken && (req.images || []).length > 0 && req.images!.every((i) => !!i.uri);
    let r;
    try {
      r = await call(canUseFiles);
    } catch (e) {
      if (!canUseFiles) throw e;
      this.fileUrisBroken = true;
      r = await call(false);
    }
    return { data: r.json as T, usage: r.usage, model: r.model, provider: this.name };
  }
}


/**
 * Local provider — proxies generation to the Python ai-service
 * (`/generate-json` → local VLM via onnxruntime-genai). Free: no cloud tokens, no Files API.
 */
class LocalVisionProvider implements VisionLanguageProvider {
  readonly name = 'local';
  get configured() {
    return !!config.PANEL_DETECT_URL;
  }
  modelFor() {
    return config.LOCAL_STORY_MODEL || 'local-llm';
  }
  async generateJson<T>(req: JsonRequest): Promise<JsonResult<T>> {
    const base = (config.PANEL_DETECT_URL || 'http://127.0.0.1:8001').replace(/\/+$/, '');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 900_000);
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

const providers: Record<string, VisionLanguageProvider> = { gemini: new GeminiVisionProvider(), local: new LocalVisionProvider() };

export const getVisionProvider = (name = process.env.AI_PROVIDER || 'gemini'): VisionLanguageProvider => {
  const p = providers[name];
  if (!p) throw new Error(`Unknown AI provider "${name}". Available: ${Object.keys(providers).join(', ')}`);
  return p;
};

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
