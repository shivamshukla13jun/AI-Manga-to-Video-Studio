import { Types } from 'mongoose';
import config from 'config/env';
import MangaChapter from 'models/manga-chapter.model';
import ComicImage from 'models/comic-image.model';
import DetectedScene from 'models/detected-scene.model';
import Character from 'models/character.model';
import { getVisionProvider } from 'libs/ai/provider';
import { countTokens } from 'libs/ai/gemini.client';
import { finalizeEstimate, heuristicTokens, imageTokens, thinkingFactor } from 'libs/pricing/estimator';
import { storySystem } from 'libs/ai/prompts';

const PROMPT_OVERHEAD_TOKENS = 1800; // system prompt + schema + context per request
const OUTPUT_TOKENS_PER_SEGMENT = 380;
const OUTPUT_TOKENS_PER_SCENE_GROUPING = 140;
const TOKENS_PER_WORD: Record<string, number> = { hi: 3.2, en: 1.4, default: 2.2 };
const WORDS_PER_SCENE = { original: 60, recap: 35 };

/** Vision analysis cost: image tokens of every panel crop/tile at ≤1024px width, plus grouping. */
export const estimateSceneDetection = async (owner: Types.ObjectId, projectId: Types.ObjectId, chapterIds: string[]) => {
  const provider = getVisionProvider();
  const chapters = await MangaChapter.find({ _id: { $in: chapterIds }, project: projectId }).sort({ number: 1 });
  const items = [];
  let requests = 0;
  let output = 0;
  let panelsAssumed = false;
  for (const c of chapters) {
    const images = await ComicImage.find({ chapter: c._id, status: { $ne: 'broken' } }).select('width height panels');
    let input = 0;
    let units = 0;
    let tiles = 0;
    for (const img of images) {
      const panels = img.panels.length ? img.panels.map((p) => p.bbox) : [{ x: 0, y: 0, width: 1, height: 1 }];
      if (!img.panels.length) panelsAssumed = true;
      for (const b of panels) {
        const w = Math.max(1, b.width * img.width);
        const h = Math.max(1, b.height * img.height);
        const outW = Math.min(1024, w);
        const outH = (h * outW) / w;
        const tileH = config.AI_TILE_HEIGHT;
        const n = outH / outW > 2.2 ? Math.max(1, Math.ceil((outH - config.AI_TILE_OVERLAP) / (tileH - config.AI_TILE_OVERLAP))) : 1;
        const perTileH = n > 1 ? Math.min(outH, tileH) : outH;
        input += n * imageTokens(Math.round(outW), Math.round(perTileH));
        tiles += n;
        units += 1;
      }
    }
    // One call covers the whole chapter when tiles fit in a single request.
    const batches = Math.max(1, Math.ceil(tiles / (Number(config.GEMINI_MAX_IMAGES_PER_CALL) || 24)));
    const segOut = units * OUTPUT_TOKENS_PER_SEGMENT;
    const groupIn = segOut + PROMPT_OVERHEAD_TOKENS;
    const groupOut = Math.ceil(units / 3) * OUTPUT_TOKENS_PER_SCENE_GROUPING;
    requests += batches + 1;
    output += segOut + groupOut;
    items.push({
      key: String(c._id),
      label: `Chapter ${c.number} — ${c.title}`,
      chapterNumber: c.number,
      requests: batches + 1,
      inputTokens: input + batches * PROMPT_OVERHEAD_TOKENS + groupIn,
      outputTokens: segOut + groupOut,
      meta: { pages: images.length, panelUnits: units, imageTiles: tiles },
    });
  }
  return finalizeEstimate({
    owner,
    project: projectId,
    kind: 'scene-detection',
    provider: provider.name,
    model: provider.modelFor('vision'),
    params: { chapterIds },
    items,
    thoughtTokens: Math.round(output * thinkingFactor()),
    requests,
    tokenCountMethod: 'heuristic',
    assumptions: [
      'Image tokens follow Gemini’s documented tiling rule (258 tokens per 768px-equivalent tile).',
      panelsAssumed ? 'Panels not detected yet for some pages — each page is assumed to be one panel (actual panel crops may differ).' : 'Uses the detected panel layout.',
      `Output ≈ ${OUTPUT_TOKENS_PER_SEGMENT} tokens per analysed panel; thinking tokens (level "${config.GEMINI_THINKING_LEVEL}") estimated at ×${thinkingFactor()} of output and billed as output.`,
      'Retries after transient API errors are not included.',
    ],
  });
};

/** Story cost: real prompt text (token-counted by the API when configured) + expected narration length. */
export const estimateStory = async (owner: Types.ObjectId, projectId: Types.ObjectId, chapterIds: string[], language: string, mode: 'original' | 'recap') => {
  const provider = getVisionProvider();
  const model = provider.modelFor('text');
  const chapters = await MangaChapter.find({ _id: { $in: chapterIds }, project: projectId }).sort({ number: 1 });
  const chars = await Character.find({ project: projectId }).select('name aliases description').limit(200);
  const system = storySystem(language, mode);
  let method: 'provider' | 'heuristic' = provider.configured ? 'provider' : 'heuristic';
  const items = [];
  let output = 0;
  for (const c of chapters) {
    const scenes = await DetectedScene.find({ chapter: c._id }).select('title characters location action emotion description events dialogues storyContext');
    const prompt = `${system}\n${JSON.stringify(chars)}\n${JSON.stringify(scenes)}`;
    let input = heuristicTokens(prompt);
    if (method === 'provider') {
      try {
        input = await countTokens(model, prompt);
      } catch {
        method = 'heuristic';
      }
    }
    const words = Math.max(1, scenes.length) * WORDS_PER_SCENE[mode];
    const out = Math.round(words * (TOKENS_PER_WORD[language] || TOKENS_PER_WORD.default)) + 600; // + summaries & characters
    output += out;
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
    thoughtTokens: Math.round(output * thinkingFactor()),
    requests: items.length,
    tokenCountMethod: method,
    assumptions: [
      method === 'provider' ? 'Input tokens counted with the provider’s countTokens API.' : 'Input tokens estimated from text length (≈4 chars/token Latin, ≈2.2 chars/token Indic).',
      `Narration length assumed ≈${WORDS_PER_SCENE[mode]} words per scene in ${mode} mode.`,
      `Thinking tokens estimated at ×${thinkingFactor()} of output and billed as output.`,
      'A corrective retry (if the model skips scenes) would add one more request per chapter.',
    ],
  });
};
