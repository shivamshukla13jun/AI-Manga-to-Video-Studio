import { Types } from 'mongoose';
import config from 'config/env';
import MangaChapter from 'models/manga-chapter.model';
import ComicImage from 'models/comic-image.model';
import DetectedScene from 'models/detected-scene.model';
import Character from 'models/character.model';
import { getVisionProvider } from 'libs/ai/provider';
import { finalizeEstimate, heuristicTokens } from 'libs/pricing/estimator';
import { getSettings } from 'libs/pricing/pricing.service';
import { visualStorySystem } from 'libs/ai/prompts';

const PROMPT_OVERHEAD_TOKENS = 1800; // system prompt + schema + context per request
const OUTPUT_TOKENS_PER_SEGMENT = 380;
const TOKENS_PER_WORD: Record<string, number> = { hi: 3.2, en: 1.4, default: 2.2 };
const WORDS_PER_SCENE = { original: 60, recap: 35 };

/** Panel/scene detection — always runs on the Python CV service, so it is free regardless of provider. */
export const estimateSceneDetection = async (owner: Types.ObjectId, projectId: Types.ObjectId, chapterIds: string[]) => {
  const chapters = await MangaChapter.find({ _id: { $in: chapterIds }, project: projectId }).sort({ number: 1 });
  const items = [];
  for (const c of chapters) {
    const pages = await ComicImage.countDocuments({ chapter: c._id, status: { $ne: 'broken' } });
    items.push({
      key: String(c._id),
      label: `Chapter ${c.number} — ${c.title} (local CV, free)`,
      chapterNumber: c.number,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      meta: { pages },
    });
  }
  return finalizeEstimate({
    owner,
    project: projectId,
    kind: 'scene-detection',
    provider: 'local',
    model: 'panel-detector',
    params: { chapterIds },
    items,
    thoughtTokens: 0,
    requests: 0,
    tokenCountMethod: 'heuristic',
    assumptions: ['Scene detection runs on the local Python computer-vision service — no AI calls.'],
  });
};

export const estimateStory = async (owner: Types.ObjectId, projectId: Types.ObjectId, chapterIds: string[], language: string, mode: 'original' | 'recap') => {
  const settings = await getSettings(owner);
  const provider = getVisionProvider(settings.aiProvider === 'local' ? 'local' : 'gemini');
  const model = provider.modelFor('text');
  const chapters = await MangaChapter.find({ _id: { $in: chapterIds }, project: projectId }).sort({ number: 1 });
  const chars = await Character.find({ project: projectId }).select('name aliases description').limit(200);
  const system = visualStorySystem(language, mode);
  const items = [];
  for (const c of chapters) {
    const scenes = await DetectedScene.find({ chapter: c._id }).select('title characters location action emotion description events dialogues storyContext');
    const prompt = `${system}\n${JSON.stringify(chars)}\n${JSON.stringify(scenes)}`;
    const input = heuristicTokens(prompt);
    const words = Math.max(1, scenes.length) * WORDS_PER_SCENE[mode];
    const out = Math.round(words * (TOKENS_PER_WORD[language] || TOKENS_PER_WORD.default)) + 600; // + summaries & characters
    items.push({
      key: String(c._id),
      label: `Chapter ${c.number} — ${c.title}`,
      chapterNumber: c.number,
      requests: 1,
      words,
      inputTokens: input + 400,
      outputTokens: out,
      meta: { scenes: scenes.length, scenesMissing: scenes.length === 0 },
    });
  }
  return finalizeEstimate({
    owner,
    project: projectId,
    kind: 'story-generation',
    provider: provider.name,
    model,
    params: { chapterIds, language, mode },
    items,
    thoughtTokens: 0,
    requests: items.length,
    tokenCountMethod: 'heuristic',
    assumptions: [
      'Input tokens estimated from text length (≈4 chars/token Latin, ≈2.2 chars/token Indic).',
      `Narration length assumed ≈${WORDS_PER_SCENE[mode]} words per scene in ${mode} mode.`,
      'A corrective retry (if the model skips scenes) would add one more request per chapter.',
      'Generation runs on the free local service / free-gemini-api proxy — no paid cost.',
    ],
  });
};
