import { Types } from 'mongoose';
import StorySegment from 'models/story-segment.model';
import { getSettings, requirePrice } from 'libs/pricing/pricing.service';
import { finalizeEstimate, heuristicTokens } from 'libs/pricing/estimator';
import { countTokens } from 'libs/ai/gemini.client';
import { getTtsProvider } from 'libs/ai/tts';
import { wordsPerMinute } from 'workers/processors/story.processor';
import config from 'config/env';

/**
 * TTS cost estimate. Text input tokens via provider countTokens (fallback
 * heuristic); audio output tokens = estimated seconds × audioTokensPerSecond
 * from the active price row (25/s documented for Gemini TTS).
 */
export const estimateTts = async (
  owner: Types.ObjectId,
  projectId: Types.ObjectId,
  params: { segmentIds: string[]; provider: 'gemini' | 'local'; voiceId: string; speed: number }
) => {
  const segments = await StorySegment.find({ _id: { $in: params.segmentIds }, project: projectId }).sort({ chapterNumber: 1, order: 1 });
  if (!segments.length) throw new Error('No narration segments selected');
  const settings = await getSettings(owner);
  const provider = getTtsProvider(params.provider);
  const model = params.provider === 'gemini' ? (config.GEMINI_TTS_MODEL as string) : `local:${params.voiceId}`;
  const price = params.provider === 'gemini' ? await requirePrice('gemini', model, settings.pricingTier) : null;
  const tokensPerSecond = price?.audioTokensPerSecond || 25;

  let method: 'provider' | 'heuristic' = params.provider === 'gemini' && provider.configured ? 'provider' : 'heuristic';
  const items = [];
  for (const seg of segments) {
    const wpm = wordsPerMinute(settings, seg.language) * params.speed;
    const seconds = seg.estimatedDuration ? seg.estimatedDuration / params.speed : (seg.wordCount / wpm) * 60;
    const audioTokens = Math.round(seconds * tokensPerSecond);
    let input = heuristicTokens(seg.narration);
    if (method === 'provider') {
      try {
        input = await countTokens(model, seg.narration);
      } catch {
        method = 'heuristic';
      }
    }
    items.push({
      key: String(seg._id),
      label: `Ch. ${seg.chapterNumber} · segment ${seg.order}`,
      chapterNumber: seg.chapterNumber,
      requests: 1,
      characters: seg.narration.length,
      words: seg.wordCount,
      durationSeconds: Math.round(seconds * 10) / 10,
      inputTokens: input,
      outputTokens: audioTokens,
      meta: { scenes: seg.scenes.length, language: seg.language },
    });
  }
  return finalizeEstimate({
    owner,
    project: projectId,
    kind: 'tts',
    provider: params.provider,
    model,
    params,
    items,
    thoughtTokens: 0,
    requests: items.length,
    tokenCountMethod: method,
    local:
      params.provider === 'local'
        ? { engine: 'local', computeSeconds: Math.round(items.reduce((n, i) => n + (i.durationSeconds || 0), 0)), storageBytes: 0 }
        : undefined,
    assumptions: [
      method === 'provider' ? 'Input tokens counted with the provider’s countTokens API.' : 'Input tokens estimated from text length (≈4 chars/token Latin, ≈2.2 chars/token Indic).',
      `Spoken duration estimated at ${Math.round(wordsPerMinute(settings, segments[0]?.language || 'hi'))} wpm ÷ speed ${params.speed}; actual duration depends on the voice.`,
      `Audio billed at ${tokensPerSecond} audio tokens per second of output.`,
      params.provider === 'local' ? 'Local TTS has no external cost.' : 'Voice replication/preview calls are not included.',
    ],
  });
};
