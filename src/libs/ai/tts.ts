import config from 'config/env';
import { AppError } from 'middlewares/error';
import { NonRetryableError } from 'libs/jobs/runner';
import { createInteraction, geminiConfigured, InteractionUsage } from './gemini.client';

export interface TtsVoice {
  id: string;
  name: string;
  provider: 'gemini' | 'local';
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
  provider: 'gemini' | 'local';
}

export interface TtsProvider {
  readonly name: 'gemini' | 'local';
  readonly configured: boolean;
  /** remote probe of an optional service — cached briefly so page loads stay fast */
  status(): Promise<{ ok: boolean; detail?: string }>;
  listVoices(): Promise<TtsVoice[]>;
  speak(req: { text: string; voiceId: string; language: string; speed?: number; signal?: AbortSignal }): Promise<SpeakResult>;
  /** Create a replicated/custom voice from reference + consent audio. Throws a clear error when unsupported. */
  replicateVoice?(req: { name: string; referenceWav: Buffer; consentWav: Buffer; language: string; signal?: AbortSignal }): Promise<{ voiceId: string }>;
}

/** Gemini 3.8 prebuilt voices (from the TTS docs). Marked clearly as prebuilt. */
export const GEMINI_PREBUILT_VOICES: { id: string; name: string; description: string }[] = [
  { id: 'Zephyr', name: 'Zephyr', description: 'Bright' },
  { id: 'Puck', name: 'Puck', description: 'Upbeat' },
  { id: 'Charon', name: 'Charon', description: 'Informative' },
  { id: 'Kore', name: 'Kore', description: 'Firm' },
  { id: 'Fenrir', name: 'Fenrir', description: 'Excitable' },
  { id: 'Leda', name: 'Leda', description: 'Youthful' },
  { id: 'Orus', name: 'Orus', description: 'Firm' },
  { id: 'Aoede', name: 'Aoede', description: 'Breezy' },
  { id: 'Callirrhoe', name: 'Callirrhoe', description: 'Easy-going' },
  { id: 'Autonoe', name: 'Autonoe', description: 'Bright' },
  { id: 'Enceladus', name: 'Enceladus', description: 'Breathy' },
  { id: 'Iapetus', name: 'Iapetus', description: 'Clear' },
  { id: 'Umbriel', name: 'Umbriel', description: 'Easy-going' },
  { id: 'Algieba', name: 'Algieba', description: 'Smooth' },
  { id: 'Despina', name: 'Despina', description: 'Smooth' },
  { id: 'Erinome', name: 'Erinome', description: 'Clear' },
  { id: 'Algenib', name: 'Algenib', description: 'Gravelly' },
  { id: 'Rasalgethi', name: 'Rasalgethi', description: 'Informative' },
  { id: 'Laomedeia', name: 'Laomedeia', description: 'Upbeat' },
  { id: 'Achernar', name: 'Achernar', description: 'Soft' },
  { id: 'Alnilam', name: 'Alnilam', description: 'Firm' },
  { id: 'Schedar', name: 'Schedar', description: 'Even' },
  { id: 'Gacrux', name: 'Gacrux', description: 'Mature' },
  { id: 'Pulcherrima', name: 'Pulcherrima', description: 'Forward' },
  { id: 'Achird', name: 'Achird', description: 'Friendly' },
  { id: 'Zubenelgenubi', name: 'Zubenelgenubi', description: 'Casual' },
  { id: 'Vindemiatrix', name: 'Vindemiatrix', description: 'Gentle' },
  { id: 'Sadachbia', name: 'Sadachbia', description: 'Lively' },
  { id: 'Sadaltager', name: 'Sadaltager', description: 'Knowledgeable' },
  { id: 'Sulafat', name: 'Sulafat', description: 'Warm' },
];

const ttsUsage = (u: InteractionUsage): InteractionUsage => u;

/** Ordered TTS fallback chain: flash-tts → lite-tts (or GEMINI_TTS_MODELS). */
const ttsModels = (): string[] =>
  (config.GEMINI_TTS_MODELS as string).split(',').map((m) => m.trim()).filter(Boolean);

class GeminiTts implements TtsProvider {
  readonly name = 'gemini' as const;
  get configured() {
    return geminiConfigured();
  }
  async status() {
    return this.configured ? { ok: true } : { ok: false, detail: 'GEMINI_API_KEY not set on the server' };
  }
  async listVoices(): Promise<TtsVoice[]> {
    return GEMINI_PREBUILT_VOICES.map((v) => ({
      id: v.id,
      name: v.name,
      provider: 'gemini',
      languages: ['hi', 'en'],
      description: v.description,
    }));
  }
  async speak(req: { text: string; voiceId: string; language: string; speed?: number; signal?: AbortSignal }): Promise<SpeakResult> {
    // Interactions API: request an audio response with a prebuilt voice.
    // NOTE: verify the exact speech_config field names against the live API
    // when a key is available — the mock server tolerates the whole payload.
    const r = await createInteraction({
      model: ttsModels(),
      input: [{ type: 'text', text: req.text }],
      generationConfig: {
        response_modalities: ['AUDIO'],
        speech_config: {
          voice_config: { prebuilt_voice_config: { voice_name: req.voiceId } },
          language_code: req.language,
          ...(req.speed && req.speed !== 1 ? { speaking_rate: req.speed } : {}),
        },
      },
      signal: req.signal,
    });
    if (!r.audio?.data) throw new Error('Gemini TTS returned no audio');
    return { audio: Buffer.from(r.audio.data, 'base64'), mimeType: r.audio.mimeType || 'audio/wav', usage: ttsUsage(r.usage), model: r.model, provider: 'gemini' };
  }
  async replicateVoice(req: { name: string; referenceWav: Buffer; consentWav: Buffer; language: string; signal?: AbortSignal }): Promise<{ voiceId: string }> {
    // Voice replication on Gemini requires the account to have the feature
    // enabled. Attempt the documented call; surface the provider error clearly.
    try {
      const r = await createInteraction({
        model: config.GEMINI_TTS_MODEL as string,
        input: [
          { type: 'text', text: `Create a reusable voice profile named "${req.name}". The second audio sample is an explicit consent statement from the speaker. Return the voice id.` },
          { type: 'audio', data: req.referenceWav.toString('base64'), mime_type: 'audio/wav' },
          { type: 'audio', data: req.consentWav.toString('base64'), mime_type: 'audio/wav' },
        ],
        responseFormat: { type: 'voice_profile' } as any,
        signal: req.signal,
      });
      const voiceId = (r.raw?.voice_profile?.id || r.raw?.voiceProfile?.name || r.json?.voiceId || '') as string;
      if (!voiceId) throw new Error('provider returned no voice id');
      return { voiceId };
    } catch (e: any) {
      if (e instanceof NonRetryableError || e instanceof AppError) throw e;
      throw new NonRetryableError(
        `Voice replication is not available for this account/API access (${e.message}). Use a prebuilt voice or a local TTS engine.`,
        'VOICE_CLONE_UNSUPPORTED'
      );
    }
  }
}

/** Optional Python inference service (ai-service/) hosting Piper/Kokoro/XTTS. */
class LocalTts implements TtsProvider {
  readonly name = 'local' as const;
  get configured() {
    return true; // always reachable attempt; status() reports health
  }
  private async call(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${config.LOCAL_TTS_URL}${path}`, {
      ...init,
      signal: init?.signal || AbortSignal.timeout(config.GEMINI_TIMEOUT_MS),
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

const ttsProviders: Record<string, TtsProvider> = { gemini: new GeminiTts(), local: new LocalTts() };

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
