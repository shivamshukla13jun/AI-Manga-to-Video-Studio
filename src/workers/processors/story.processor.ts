import { Types } from 'mongoose';
import MangaProject from 'models/manga-project.model';
import MangaChapter, { IMangaChapterDocument } from 'models/manga-chapter.model';
import DetectedScene, { IDetectedSceneDocument } from 'models/detected-scene.model';
import StorySegment from 'models/story-segment.model';
import Character from 'models/character.model';
import { registerJobHandler, NonRetryableError, JobContext } from 'libs/jobs/runner';
import { getVisionProvider, recordUsage, VisionImage } from 'libs/ai/provider';
import { countWords, rewriteInstruction, rewriteSchema, RewriteAction, storySchema, storySystem, visualStorySystem } from 'libs/ai/prompts';
import { getSettings } from 'libs/pricing/pricing.service';
import { emitToUser } from 'libs/realtime/events';
import { serializeChapter } from 'microservices/manga-service/manga.serializers';
import { upsertCharacters } from './scene.processor';
import ComicImage from 'models/comic-image.model';
import { cropRegion } from 'libs/studio/panels';
import { resolveLocal } from 'libs/studio/media';
import { makeTempDir, removeDir } from 'libs/studio/paths';
import { uploadFile } from 'libs/ai/gemini.client';

export const wordsPerMinute = (settings: { wordsPerMinute?: Record<string, number> }, language: string) =>
  Number(settings.wordsPerMinute?.[language] || settings.wordsPerMinute?.default || 145);

export const estimateSeconds = (words: number, wpm: number) => Math.round((words / Math.max(60, wpm)) * 60 * 10) / 10;

const sceneForPrompt = (s: IDetectedSceneDocument, n: number) => ({
  sceneNumber: n,
  title: s.title,
  characters: s.characters,
  location: s.location,
  action: s.action,
  emotion: s.emotion,
  description: s.description,
  events: s.events,
  dialogues: s.dialogues.map((d) => `${d.speaker ? d.speaker + ': ' : ''}"${d.text}"${d.uncertain ? ' [UNCERTAIN OCR]' : ''} (${d.kind})`),
  storyContext: s.storyContext,
});

const characterRegistry = async (projectId: Types.ObjectId) =>
  (await Character.find({ project: projectId }).select('name aliases description pronunciation').limit(200)).map((c) => ({
    name: c.name,
    aliases: c.aliases,
    description: c.description,
    pronunciation: c.pronunciation,
  }));

const validCoverage = (segments: any[], sceneCount: number) => {
  const flat = segments.flatMap((s) => (s.sceneNumbers || []).map(Number));
  return flat.length === sceneCount && flat.every((n: number, i: number) => n === i + 1) && segments.every((s) => s.sceneNumbers?.length && s.narration?.trim());
};

type Report = (frac: number, stage: string) => Promise<void>;

/** Crop every scene's regions; for Gemini, upload them to the Files API once — one vision call per chapter. */
const sceneImages = async (ctx: JobContext, scenes: IDetectedSceneDocument[], tempDir: string, useFilesApi: boolean, report: Report) => {
  const docs = new Map((await ComicImage.find({ _id: { $in: scenes.flatMap((s) => s.regions.map((r) => r.image)) } })).map((i) => [String(i._id), i]));
  const images: VisionImage[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const parts = scenes[i].regions.slice(0, 3);
    for (let k = 0; k < parts.length; k++) {
      const img = docs.get(String(parts[k].image));
      if (!img?.file) continue;
      const local = await resolveLocal(img.file, tempDir);
      images.push({
        data: await cropRegion(local, parts[k].bbox),
        mimeType: 'image/jpeg',
        label: parts.length > 1 ? `SCENE ${i + 1} · PART ${k + 1}` : `SCENE ${i + 1}`,
      });
    }
    await report((i + 1) / scenes.length * 0.3, `Cropping scene ${i + 1}/${scenes.length}`);
  }
  await ctx.log(`${images.length} scene image(s) cropped from ${scenes.length} scenes`);
  if (!useFilesApi) return images;
  const total = images.length;
  let done = 0;
  const queue = images.map((img, i) => ({ img, label: img.label || `scene-${i}` }));
  await Promise.all(
    Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift()!;
        const f = await uploadFile(item.img.data, 'image/jpeg', item.label, ctx.signal, (m, l) => ctx.log(m, l));
        if (f) item.img.uri = f.uri;
        await report(0.3 + (++done / total) * 0.3, `Uploading scene image ${done}/${total} to Files API`);
      }
    })
  );
  const uploaded = images.filter((i) => i.uri).length;
  if (uploaded) await ctx.log(`Uploaded ${uploaded} scene image(s) to Gemini Files API`, 'info');
  return images;
};

const generateChapter = async (
  ctx: JobContext,
  chapter: IMangaChapterDocument,
  scenes: IDetectedSceneDocument[],
  opts: { language: string; mode: 'original' | 'recap'; continuity?: string; previousSummary?: string; projectId: Types.ObjectId; title: string; provider: 'local' | 'gemini' },
  tempDir: string,
  report: Report
) => {
  const provider = getVisionProvider(opts.provider);
  const images = await sceneImages(ctx, scenes, tempDir, opts.provider === 'gemini', report);
  await report(0.62, 'Building prompt and character registry');
  const base = [
    `Manga: ${opts.title}. Chapter ${chapter.number}${chapter.title ? ` — ${chapter.title}` : ''}.`,
    `This chapter has ${scenes.length} scenes, shown as images labelled SCENE 1..${scenes.length}.`,
    `Known characters (JSON): ${JSON.stringify(await characterRegistry(opts.projectId))}`,
    opts.continuity ? `Story so far: ${opts.continuity}` : 'This is the beginning of the story.',
    opts.previousSummary ? `Previous chapter summary: ${opts.previousSummary}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  let prompt = base;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const label = `Chapter ${chapter.number}: waiting for ${provider.name}`;
    await report(0.65 + (attempt - 1) * 0.08, attempt > 1 ? `${label} (retry)` : label);
    await ctx.log(`Requesting narration for chapter ${chapter.number} — ${images.length} scene image(s), ${scenes.length} scenes · ${provider.name}${attempt > 1 ? ' (coverage retry)' : ''}`);
    const started = Date.now();
    const r = await provider.generateJson<any>({ system: visualStorySystem(opts.language, opts.mode), prompt, images, schema: storySchema, kind: 'vision', signal: ctx.signal, onLog: (m, l) => ctx.log(m, l) });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    await recordUsage({ owner: ctx.job.owner, project: opts.projectId, job: ctx.job._id as any, provider: r.provider, model: r.model, kind: 'vision', usage: r.usage });
    const tokens = (r.usage?.inputTokens || 0) + (r.usage?.outputTokens || 0) + (r.usage?.thoughtTokens || 0);
    await ctx.log(`Chapter ${chapter.number}: ${provider.name}/${r.model} responded in ${secs}s — ${tokens.toLocaleString()} tokens, ${r.data?.segments?.length || 0} segment(s)`);
    if (validCoverage(r.data?.segments || [], scenes.length)) return r.data;
    await ctx.log(`Chapter ${chapter.number}: narration did not cover scenes 1..${scenes.length} exactly once in order — asking the model to correct it`, 'warn');
    prompt = `${base}\n\nIMPORTANT: your previous answer skipped, repeated or reordered scene numbers. Every scene number 1..${scenes.length} must appear exactly once, in order, in contiguous groups, each with non-empty narration.`;
  }
  throw new Error(`Chapter ${chapter.number}: the model could not produce narration covering every scene. Try again or edit scenes first.`);
};

export const generateRange = async (ctx: JobContext<{ projectId: string; chapterIds: string[]; language: string; mode: 'original' | 'recap'; overwriteEdited?: boolean; provider?: string }>) => {
  await ctx.progress(1, 'Loading project and settings');
  const project = await MangaProject.findById(ctx.payload.projectId);
  if (!project) throw new NonRetryableError('Project no longer exists');
  const settings = await getSettings(project.owner);
  const aiProvider = (ctx.payload.provider || settings.aiProvider || 'gemini') as 'local' | 'gemini';
  const provider = getVisionProvider(aiProvider);
  if (!provider.configured) throw new NonRetryableError(`AI provider "${provider.name}" is not configured (missing API key on the server).`, 'AI_NOT_CONFIGURED');
  const { language, mode } = ctx.payload;
  const chapters = (await MangaChapter.find({ _id: { $in: ctx.payload.chapterIds } })).sort(
    (a, b) => ctx.payload.chapterIds.indexOf(String(a._id)) - ctx.payload.chapterIds.indexOf(String(b._id))
  );
  if (!chapters.length) throw new NonRetryableError('No chapters selected');
  await ctx.log(`Writing ${mode} narration in ${language} for ${chapters.length} chapter(s): ${chapters.map((c) => c.number).join(', ')} · provider ${provider.name}`);

  await ctx.progress(3, 'Checking scene coverage');
  const noScenes = [];
  for (const c of chapters) if (!(await DetectedScene.exists({ chapter: c._id }))) noScenes.push(c.number);
  if (noScenes.length) throw new NonRetryableError(`Detect scenes first for chapter(s) ${noScenes.join(', ')}`, 'NO_SCENES');
  const edited = await StorySegment.countDocuments({ chapter: { $in: chapters.map((c) => c._id) }, language, mode, userEdited: true });
  if (edited && !ctx.payload.overwriteEdited) {
    throw new NonRetryableError(`${edited} narration segment(s) were edited by you. Confirm overwrite, or regenerate individual segments.`, 'EDIT_LOCK');
  }

  const wpm = wordsPerMinute(settings, language);
  let continuity = project.continuitySummary;
  // continuing from earlier chapters only makes sense if the summary stops before this range
  if (project.continuityThrough !== undefined && project.continuityThrough >= chapters[0].number) {
    const prev = await MangaChapter.findOne({ project: project._id, number: { $lt: chapters[0].number }, summary: { $exists: true } }).sort({ number: -1 });
    continuity = prev?.summary ? `Up to chapter ${prev.number}: ${prev.summary}` : undefined;
  }
  let previousSummary: string | undefined;
  let totalSegments = 0;
  const tempDir = await makeTempDir('story');
  try {
  for (let i = 0; i < chapters.length; i++) {
    ctx.throwIfCancelled();
    const chapter = chapters[i];
    const bandStart = (100 * i) / chapters.length + 4;
    const bandSize = 96 / chapters.length;
    const report: Report = (frac, stage) => ctx.progress(bandStart + frac * bandSize, `Ch ${chapter.number} (${i + 1}/${chapters.length}): ${stage}`);
    await report(0, `preparing (${i + 1}/${chapters.length})`);
    chapter.storyStatus = 'processing';
    await chapter.save();
    await emitToUser(chapter.owner, 'chapter:update', serializeChapter(chapter), chapter.project);
    try {
      const scenes = await DetectedScene.find({ chapter: chapter._id }).sort({ order: 1 });
      await ctx.log(`Chapter ${chapter.number}: loaded ${scenes.length} detected scene(s)`);
      const out = await generateChapter(ctx, chapter, scenes, { language, mode, continuity, previousSummary, projectId: project._id as Types.ObjectId, title: project.title, provider: aiProvider }, tempDir, report);
      ctx.throwIfCancelled();

      await report(0.9, `Saving ${out.segments.length} narration segment(s)`);
      await StorySegment.deleteMany({ chapter: chapter._id, language, mode });
      let order = 0;
      for (const seg of out.segments) {
        const words = countWords(seg.narration);
        await StorySegment.create({
          owner: chapter.owner,
          project: project._id,
          chapter: chapter._id,
          chapterNumber: chapter.number,
          scenes: seg.sceneNumbers.map((n: number) => scenes[n - 1]._id),
          order: ++order,
          language,
          mode,
          title: seg.title,
          narration: seg.narration.trim(),
          emotion: seg.emotion,
          wordCount: words,
          estimatedDuration: estimateSeconds(words, wpm),
          confidence: Math.min(1, Math.max(0, Number(seg.confidence) || 0)),
          uncertainties: seg.uncertainties || [],
          history: [{ at: new Date(), source: 'ai', note: 'generated', title: seg.title, narration: seg.narration.trim() }],
        });
      }
      totalSegments += order;
      await report(0.95, 'Updating characters and continuity');
      await upsertCharacters(chapter.owner, project._id as Types.ObjectId, chapter.number, out.characters);
      chapter.summary = out.chapterSummary;
      chapter.storyStatus = 'done';
      await chapter.save();
      previousSummary = out.chapterSummary;
      continuity = out.continuitySummary;
      if (project.continuityThrough === undefined || chapter.number >= project.continuityThrough) {
        project.continuitySummary = out.continuitySummary;
        project.continuityThrough = chapter.number;
        await project.save();
      }
      await emitToUser(chapter.owner, 'chapter:update', serializeChapter(chapter), chapter.project);
      await emitToUser(chapter.owner, 'story:update', { chapter: String(chapter._id), language, mode }, chapter.project);
      await ctx.log(`Chapter ${chapter.number} done — ${order} segment(s), ${out.characters?.length || 0} character update(s)`);
    } catch (error) {
      chapter.storyStatus = 'failed';
      await chapter.save();
      await emitToUser(chapter.owner, 'chapter:update', serializeChapter(chapter), chapter.project);
      throw error;
    }
  }
  } finally {
    await removeDir(tempDir);
  }
  return { chapters: chapters.length, segments: totalSegments };
};

/** Regenerate / shorten / expand / change tone / translate one narration segment. */
const rewriteSegment = async (ctx: JobContext<{ segmentId: string; action: RewriteAction; tone?: string; language?: string; force?: boolean }>) => {
  const seg = await StorySegment.findById(ctx.payload.segmentId);
  if (!seg) throw new NonRetryableError('Narration segment no longer exists');
  const { action } = ctx.payload;
  if (action === 'regenerate' && seg.userEdited && !ctx.payload.force) {
    throw new NonRetryableError('This narration was edited by you — confirm to overwrite it', 'EDIT_LOCK');
  }
  const ownerSettings = await getSettings(seg.owner);
  const provider = getVisionProvider(ownerSettings.aiProvider === 'local' ? 'local' : 'gemini');
  if (!provider.configured) throw new NonRetryableError(`AI provider "${provider.name}" is not configured (missing API key on the server).`, 'AI_NOT_CONFIGURED');
  const project = await MangaProject.findById(seg.project);
  const scenes = await DetectedScene.find({ _id: { $in: seg.scenes } }).sort({ order: 1 });
  const [prev, next] = await Promise.all([
    StorySegment.findOne({ chapter: seg.chapter, language: seg.language, mode: seg.mode, order: { $lt: seg.order } }).sort({ order: -1 }),
    StorySegment.findOne({ chapter: seg.chapter, language: seg.language, mode: seg.mode, order: { $gt: seg.order } }).sort({ order: 1 }),
  ]);
  const language = action === 'translate' ? ctx.payload.language || seg.language : seg.language;
  await ctx.progress(20, `${action} narration`);
  await ctx.log(`Requesting ${action} for segment ${seg.order} (chapter ${seg.chapterNumber}) · ${provider.name}`);
  const started = Date.now();
  const r = await provider.generateJson<any>({
    system: storySystem(language, seg.mode),
    prompt: [
      `Task: ${rewriteInstruction(action, { tone: ctx.payload.tone, language })}`,
      `Known characters: ${JSON.stringify(await characterRegistry(seg.project))}`,
      project?.continuitySummary ? `Story so far: ${project.continuitySummary}` : '',
      prev ? `Previous segment narration: ${prev.narration}` : '',
      next ? `Next segment narration: ${next.narration}` : '',
      `Scenes of this segment (JSON): ${JSON.stringify(scenes.map((s, i) => sceneForPrompt(s, i + 1)))}`,
      action !== 'regenerate' ? `Current narration: ${seg.narration}` : '',
      'Return the narration for this single segment only.',
    ]
      .filter(Boolean)
      .join('\n'),
    schema: rewriteSchema,
    kind: 'text',
    signal: ctx.signal,
    onLog: (m, l) => ctx.log(m, l),
  });
  await recordUsage({ owner: ctx.job.owner, project: seg.project, job: ctx.job._id as any, provider: r.provider, model: r.model, kind: 'text', usage: r.usage });
  await ctx.log(`${provider.name}/${r.model} responded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const narration = String(r.data?.narration || '').trim();
  if (!narration) throw new Error('The model returned empty narration');

  seg.history.push({ at: new Date(), source: 'ai', note: action, title: r.data.title, narration });
  seg.history = seg.history.slice(-40);
  const words = countWords(narration);
  seg.set({
    title: r.data.title || seg.title,
    narration,
    emotion: r.data.emotion || seg.emotion,
    tone: action === 'tone' ? ctx.payload.tone : seg.tone,
    language,
    wordCount: words,
    estimatedDuration: estimateSeconds(words, wordsPerMinute(ownerSettings, language)),
    confidence: r.data.confidence,
    uncertainties: r.data.uncertainties || [],
    userEdited: action === 'regenerate' ? false : seg.userEdited,
    version: seg.version + 1,
  });
  await seg.save();
  await emitToUser(seg.owner, 'story:update', { chapter: String(seg.chapter), segment: String(seg._id) }, seg.project);
  return { segmentId: String(seg._id) };
};

registerJobHandler<any>('story-generation', async (ctx) => (ctx.payload.segmentId ? rewriteSegment(ctx) : generateRange(ctx)));
