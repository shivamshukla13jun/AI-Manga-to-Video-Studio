import { Types } from 'mongoose';
import StorySegment from 'models/story-segment.model';
import { getSettings } from 'libs/pricing/pricing.service';
import { finalizeEstimate, heuristicTokens } from 'libs/pricing/estimator';
import { getTtsProvider } from 'libs/ai/tts';
import { wordsPerMinute } from 'workers/processors/story.processor';

/**
 * TTS cost estimate — local voices only, so cost is always $0; tokens are
 * estimated heuristically for display. Audio output tokens = estimated
 * seconds × 25/s (kept for comparison with cloud TTS pricing).
 */
export const estimateTts = async (
  owner: Types.ObjectId,
  projectId: Types.ObjectId,
  params: { segmentIds: string[]; provider: 'gemini' | 'local'; voiceId: string; speed: number }
) => {
  const segments = await StorySegment.find({ _id: { $in: params.segmentIds }, project: projectId }).sort({ chapterNumber: 1, order: 1 });
  if (!segments.length) throw new Error('No narration segments selected');
  const settings = await getSettings(owner);
  getTtsProvider(params.provider); // 'gemini' → AppError: cloud TTS was removed
  const model = `local:${params.voiceId}`;
  const tokensPerSecond = 25;

  const items = [];
  for (const seg of segments) {
    const wpm = wordsPerMinute(settings, seg.language) * params.speed;
    const seconds = seg.estimatedDuration ? seg.estimatedDuration / params.speed : (seg.wordCount / wpm) * 60;
    const audioTokens = Math.round(seconds * tokensPerSecond);
    const input = heuristicTokens(seg.narration);
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
    tokenCountMethod: 'heuristic',
    local: { engine: 'local', computeSeconds: Math.round(items.reduce((n, i) => n + (i.durationSeconds || 0), 0)), storageBytes: 0 },
    assumptions: [
      'Input tokens estimated from text length (≈4 chars/token Latin, ≈2.2 chars/token Indic).',
      `Spoken duration estimated at ${Math.round(wordsPerMinute(settings, segments[0]?.language || 'hi'))} wpm ÷ speed ${params.speed}; actual duration depends on the voice.`,
      'Local TTS has no external cost.',
    ],
  });
};
