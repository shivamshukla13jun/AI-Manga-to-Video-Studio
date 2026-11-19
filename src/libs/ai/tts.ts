import config from 'config/env';
import { AppError } from 'middlewares/error';
import { NonRetryableError } from 'libs/jobs/runner';
import { InteractionUsage } from './provider';

export interface TtsVoice {
  id: string;
  name: string;
  provider: 'local';
  engine?: string;
  languages: string[];
  gender?: string;
  description?: string;
  /** custom/replicated voices only: whether the provider reports replication support */
  custom?: boolean;
}

export interface SpeakResult {
  audio: Buffer;
  mimeType: string;
  usage: InteractionUsage;
  model: string;
  provider: 'local';
}

export interface TtsProvider {
  readonly name: 'local';
  readonly configured: boolean;
  /** remote probe of an optional service — cached briefly so page loads stay fast */
  status(): Promise<{ ok: boolean; detail?: string }>;
  listVoices(): Promise<TtsVoice[]>;
  speak(req: { text: string; voiceId: string; language: string; speed?: number; signal?: AbortSignal; onLog?: (message: string, level?: 'info' | 'warn' | 'error') => void | Promise<void> }): Promise<SpeakResult>;
  /** Create a replicated/custom voice from reference + consent audio. Throws a clear error when unsupported. */
  replicateVoice?(req: { name: string; referenceWav: Buffer; consentWav: Buffer; language: string; signal?: AbortSignal }): Promise<{ voiceId: string }>;
}

/** Python inference service (ai-service/) hosting Piper/Kokoro/XTTS — the only TTS path. */
class LocalTts implements TtsProvider {
  readonly name = 'local' as const;
  get configured() {
    return true; // always reachable attempt; status() reports health
  }
  private async call(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${config.LOCAL_TTS_URL}${path}`, {
      ...init,
      signal: init?.signal || AbortSignal.timeout(config.LOCAL_HTTP_TIMEOUT_MS),
    });
    return res;
  }
  async status() {
    try {
      const res = await this.call('/status', { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { ok: false, detail: `local TTS service returned ${res.status}` };
      const json: any = await res.json();
      const engines = (json.engines || []).filter((e: any) => e.available).map((e: any) => e.id).join(', ');
      return { ok: true, detail: engines ? `engines: ${engines}` : 'running, no engines installed' };
    } catch {
      return { ok: false, detail: `not reachable at ${config.LOCAL_TTS_URL} (start ai-service to enable local voices)` };
    }
  }
  async listVoices(): Promise<TtsVoice[]> {
    const res = await this.call('/voices', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new AppError(`Local TTS service error ${res.status} — is ai-service running?`, 502);
    const json: any = await res.json();
    return (json.voices || []).map((v: any) => ({
      id: v.id,
      name: v.name || v.id,
      provider: 'local' as const,
      engine: v.engine,
      languages: v.languages || [v.language || 'en'],
      gender: v.gender,
      description: v.description,
      custom: !!v.custom,
    }));
  }
  async speak(req: { text: string; voiceId: string; language: string; speed?: number; signal?: AbortSignal }): Promise<SpeakResult> {
    const res = await this.call('/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: req.text, voice: req.voiceId, language: req.language, speed: req.speed || 1 }),
      signal: req.signal,
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new NonRetryableError(`Local TTS failed (${res.status}): ${msg.slice(0, 300) || res.statusText}`, 'LOCAL_TTS_ERROR');
    }
    const audio = Buffer.from(await res.arrayBuffer());
    return { audio, mimeType: res.headers.get('content-type') || 'audio/wav', usage: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 }, model: `local:${req.voiceId}`, provider: 'local' };
  }
}

const ttsProviders: Record<string, TtsProvider> = { local: new LocalTts() };

export const getTtsProvider = (name: string): TtsProvider => {
  const p = ttsProviders[name];
  if (!p) throw new AppError(`Unknown TTS provider "${name}". Available: ${Object.keys(ttsProviders).join(', ')}`, 400);
  return p;
};

/** Best-effort duration estimate used before generation (chars/word → speech). */
export const estimateSpeechSeconds = (text: string, wordsPerMinute: number, speed = 1) => {
  const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
  return words > 0 ? (words / (wordsPerMinute * (speed || 1))) * 60 : 0;
};
