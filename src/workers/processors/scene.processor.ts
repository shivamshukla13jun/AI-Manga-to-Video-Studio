import { Types } from 'mongoose';
import MangaProject from 'models/manga-project.model';
import MangaChapter from 'models/manga-chapter.model';
import ComicImage, { IComicImageDocument } from 'models/comic-image.model';
import DetectedScene, { IDialogue } from 'models/detected-scene.model';
import Character from 'models/character.model';
import StorySegment from 'models/story-segment.model';
import { getSettings } from 'libs/pricing/pricing.service';
import { estimateSeconds, wordsPerMinute } from './story.processor';
import { registerJobHandler, NonRetryableError, JobContext } from 'libs/jobs/runner';
import { getVisionProvider, recordUsage, VisionImage } from 'libs/ai/provider';
import { groupingSystem, combinedSystem, PANEL_SYSTEM, groupingSchema, combinedSchema, panelSchema } from 'libs/ai/prompts';
import { uploadFile } from 'libs/ai/gemini.client';
import config from 'config/env';
import { cropRegion, detectPanels, NBox, tileRegion } from 'libs/studio/panels';
import { deleteFileById, projectFolder, resolveLocal, storeBuffer } from 'libs/studio/media';
import { makeTempDir, removeDir } from 'libs/studio/paths';
import { openSharp } from 'libs/studio/images';
import { emitToUser } from 'libs/realtime/events';
import { serializeChapter } from 'microservices/manga-service/manga.serializers';

const MAX_IMAGES_PER_REQUEST = () => Number(config.GEMINI_MAX_IMAGES_PER_CALL) || 24;
const TALL_PANEL_RATIO = 2.2;

interface Unit {
  id: number;
  image: IComicImageDocument;
  bbox: NBox;
  tiles: { data: Buffer; start: number; end: number; uri?: string }[];
}

interface Segment {
  id: number;
  image: IComicImageDocument;
  bbox: NBox;
  characters: string[];
  action?: string;
  emotion?: string;
  location?: string;
  events: string[];
  dialogues: IDialogue[];
  visualDescription?: string;
  sceneStart: boolean;
  confidence: number;
}

const knownCharacters = async (projectId: Types.ObjectId) =>
  (await Character.find({ project: projectId }).select('name aliases appearance description').limit(200)).map((c) => ({
    name: c.name,
    aliases: c.aliases,
    appearance: c.appearance,
  }));

/** Ensure every usable page has panels (CV). User-edited panels are never replaced. */
export const ensurePanels = async (images: IComicImageDocument[], tempDir: string, rtl: boolean, force = false) => {
  for (const img of images) {
    if (img.panels.some((p) => p.source === 'user')) continue;
    if (img.panels.length && img.panelsDetectedAt && !force) continue;
    const local = await resolveLocal(img.file!, tempDir);
    const boxes = await detectPanels(local, { rtl });
    img.panels = (boxes.length ? boxes : [{ x: 0, y: 0, width: 1, height: 1 }]).map((bbox, order) => ({ bbox, order, source: 'cv' })) as any;
    img.panelsDetectedAt = new Date();
    await img.save();
  }
};

/** Upload all unit tiles to the Gemini Files API once (fewer bytes per request, reusable across retries). */
const uploadUnitTiles = async (ctx: JobContext, units: Unit[]) => {
  const flat = units.flatMap((u) => u.tiles.map((t) => ({ t, label: `unit-${u.id}` })));
  if (!flat.length) return;
  const POOL = 6;
  await Promise.all(
    Array.from({ length: Math.min(POOL, flat.length) }, async () => {
      while (flat.length) {
        const item = flat.shift()!;
        const f = await uploadFile(item.t.data, 'image/jpeg', item.label, ctx.signal);
        if (f) item.t.uri = f.uri;
      }
    })
  );
  const uploaded = units.reduce((n, u) => n + u.tiles.filter((t) => t.uri).length, 0);
  if (uploaded) await ctx.log(`Uploaded ${uploaded} panel image(s) to Gemini Files API — requests reference them by URI`, 'info');
};

/** Map the model's per-unit segment output onto Unit geometry into the flat Segment list. */
const applyUnitsResult = (units: Unit[], unitsData: any[], segments: Segment[], warn?: (u: Unit) => void) => {
  const byUnit = new Map<number, any>((unitsData || []).map((x) => [Number(x.unit), x]));
  for (const u of units) {
    const result = byUnit.get(u.id);
    if (!result?.segments?.length) warn?.(u);
    const raw = result?.segments?.length ? result.segments : [{ startTile: 1, startY: 0, characters: [], events: [], dialogues: [], sceneStart: false, confidence: 0 }];
    const starts = raw.map((seg: any) => {
      const tile = u.tiles[Math.min(u.tiles.length, Math.max(1, Number(seg.startTile) || 1)) - 1];
      const y = Math.min(1, Math.max(0, Number(seg.startY) || 0));
      return tile.start + y * (tile.end - tile.start);
    });
    starts[0] = 0;
    for (let i = 0; i < raw.length; i++) {
      const seg = raw[i];
      const from = Math.max(starts[i], i ? starts[i - 1] + 0.01 : 0);
      const to = i + 1 < raw.length ? Math.max(from + 0.01, starts[i + 1]) : 1;
      if (to - from < 0.01) continue;
      segments.push({
        id: segments.length + 1,
        image: u.image,
        bbox: { x: u.bbox.x, width: u.bbox.width, y: u.bbox.y + from * u.bbox.height, height: (to - from) * u.bbox.height },
        characters: seg.characters || [],
        action: seg.action,
        emotion: seg.emotion,
        location: seg.location,
        events: seg.events || [],
        dialogues: (seg.dialogues || []).filter((d: any) => d?.text).map((d: any) => ({ speaker: d.speaker || undefined, text: d.text, kind: d.kind || 'speech', uncertain: !!d.uncertain })),
        visualDescription: seg.visualDescription,
        sceneStart: !!seg.sceneStart,
        confidence: Math.min(1, Math.max(0, Number(seg.confidence) || 0)),
      });
    }
  }
};

/**
 * One-shot: all units + scene grouping + narration in a single Gemini call
 * (images referenced via Files API URIs when upload succeeded).
 * Returns null when the response fails coverage validation - caller falls
 * back to the staged pipeline.
 */
const analyseAndGroup = async (ctx: JobContext, units: Unit[], context: { characters: unknown; continuity?: string; chapterNumber: number; language: string; narrationLanguage: string; mode: 'original' | 'recap' }) => {
  const provider = getVisionProvider();
  const images: VisionImage[] = [];
  for (const u of units) {
    u.tiles.forEach((t, i) => images.push({ data: t.data, uri: t.uri, mimeType: 'image/jpeg', label: u.tiles.length > 1 ? `UNIT ${u.id} · TILE ${i + 1}/${u.tiles.length}` : `UNIT ${u.id}` }));
  }
  const prompt = [
    `Comic source language: ${context.language}. Chapter ${context.chapterNumber} has ${units.length} units.`,
    `Known characters (JSON): ${JSON.stringify(context.characters)}`,
    context.continuity ? `Story so far: ${context.continuity}` : '',
  ].filter(Boolean).join('\n');
  const r = await provider.generateJson<{ units: any[]; scenes: any[]; characters: any[] }>({
    system: combinedSystem(context.narrationLanguage, context.mode),
    prompt,
    images,
    schema: combinedSchema,
    kind: 'vision',
    signal: ctx.signal,
  });
  await recordUsage({ owner: ctx.job.owner, project: ctx.job.project, job: ctx.job._id as any, provider: r.provider, model: r.model, kind: 'vision', usage: r.usage });
  if (!r.data?.units?.length) return null;

  const segments: Segment[] = [];
  const segToOurs = new Map<number, number>();
  for (const ud of r.data.units) for (const seg of ud.segments || []) segToOurs.set(Number(seg.seg), segToOurs.size + 1);
  applyUnitsResult(units, r.data.units, segments, (u) => ctx.log(`Model returned no analysis for unit ${u.id} (page ${u.image.index + 1}); kept as an unanalysed segment`, 'warn').catch(() => {}));

  const scenes = (r.data.scenes || []).map((s: any) => ({ ...s, segmentIds: (s.segmentIds || []).map((id: any) => segToOurs.get(Number(id)) ?? Number(id)) }));
  const flat = scenes.flatMap((s: any) => s.segmentIds);
  const valid = flat.length === segments.length && flat.every((id, i) => id === i + 1) && scenes.every((s: any) => s.segmentIds?.length);
  if (!valid) {
    await ctx.log('Single-call response failed scene coverage validation — falling back to staged pipeline', 'warn');
    return null;
  }
  return { segments, grouped: { scenes, characters: r.data.characters || [] } };
};

/** Stage 1: vision analysis of panel crops / tiles, batched. */
const analyseUnits = async (ctx: JobContext, units: Unit[], context: { characters: unknown; continuity?: string; language: string }) => {
  const provider = getVisionProvider();
  const segments: Segment[] = [];
  const batches: Unit[][] = [];
  let current: Unit[] = [];
  let count = 0;
  for (const u of units) {
    if (current.length && count + u.tiles.length > MAX_IMAGES_PER_REQUEST()) {
      batches.push(current);
      current = [];
      count = 0;
    }
    current.push(u);
    count += u.tiles.length;
  }
  if (current.length) batches.push(current);

  let previous = '';
  for (let b = 0; b < batches.length; b++) {
    ctx.throwIfCancelled();
    const batch = batches[b];
    const images: VisionImage[] = [];
    for (const u of batch) {
      u.tiles.forEach((t, i) =>
        images.push({
          data: t.data,
          uri: t.uri,
          mimeType: 'image/jpeg',
          label: u.tiles.length > 1 ? `UNIT ${u.id} · TILE ${i + 1}/${u.tiles.length}` : `UNIT ${u.id}`,
        })
      );
    }
    const prompt = [
      `Comic source language: ${context.language}.`,
      `Known characters (JSON): ${JSON.stringify(context.characters)}`,
      context.continuity ? `Story so far: ${context.continuity}` : '',
      previous ? `The previous unit (just before this batch) showed: ${previous}` : 'This batch starts the chapter.',
      `Analyse units ${batch.map((u) => u.id).join(', ')} and return one entry per unit.`,
    ]
      .filter(Boolean)
      .join('\n');

    const r = await provider.generateJson<{ units: any[] }>({ system: PANEL_SYSTEM, prompt, images, schema: panelSchema, kind: 'vision', signal: ctx.signal });
    await recordUsage({ owner: ctx.job.owner, project: ctx.job.project, job: ctx.job._id as any, provider: r.provider, model: r.model, kind: 'vision', usage: r.usage });

    const before = segments.length;
    applyUnitsResult(batch, r.data?.units, segments, (u) => ctx.log(`Model returned no analysis for unit ${u.id} (page ${u.image.index + 1}); kept as an unanalysed segment`, 'warn').catch(() => {}));
    const lastSeg = segments[segments.length - 1];
    if (segments.length > before && lastSeg) previous = [lastSeg.visualDescription, lastSeg.action].filter(Boolean).join(' — ');
    await ctx.progress(10 + (60 * (b + 1)) / batches.length, `Analysing panels (batch ${b + 1}/${batches.length})`);
  }
  return segments;
};

/** Stage 2: group segments into scenes AND write each scene's narration (one Gemini call). */
const groupSegments = async (ctx: JobContext, segments: Segment[], context: { characters: unknown; continuity?: string; chapterNumber: number; language: string; mode: 'original' | 'recap' }) => {
  const provider = getVisionProvider();
  const payload = segments.map((s) => ({
    id: s.id,
    page: s.image.index + 1,
    sceneStart: s.sceneStart,
    characters: s.characters,
    location: s.location,
    action: s.action,
    emotion: s.emotion,
    events: s.events,
    dialogues: s.dialogues.map((d) => `${d.speaker ? d.speaker + ': ' : ''}${d.text}${d.uncertain ? ' [uncertain]' : ''} (${d.kind})`),
    visual: s.visualDescription,
  }));
  const r = await provider.generateJson<{ scenes: any[]; characters: any[] }>({
    system: groupingSystem(context.language, context.mode),
    prompt: [
      `Chapter ${context.chapterNumber}. Known characters: ${JSON.stringify(context.characters)}`,
      context.continuity ? `Story so far: ${context.continuity}` : '',
      `Segments (JSON, in reading order): ${JSON.stringify(payload)}`,
    ]
      .filter(Boolean)
      .join('\n'),
    schema: groupingSchema,
    kind: 'text',
    signal: ctx.signal,
  });
  await recordUsage({ owner: ctx.job.owner, project: ctx.job.project, job: ctx.job._id as any, provider: r.provider, model: r.model, kind: 'text', usage: r.usage });

  // Validate: contiguous, ordered, complete. Otherwise fall back to the model's sceneStart flags.
  const flat = (r.data?.scenes || []).flatMap((s) => (s.segmentIds || []).map(Number));
  const valid =
    flat.length === segments.length &&
    flat.every((id, i) => id === i + 1) &&
    (r.data.scenes || []).every((s) => s.segmentIds?.length);
  if (valid) return { scenes: r.data.scenes, characters: r.data.characters || [] };

  await ctx.log('Scene grouping from the model did not cover all segments in order — using segment scene-start markers instead', 'warn');
  const scenes: any[] = [];
  for (const s of segments) {
    if (!scenes.length || s.sceneStart) scenes.push({ segmentIds: [], title: '', characters: [], events: [], description: '', confidence: 0.4 });
    scenes[scenes.length - 1].segmentIds.push(s.id);
  }
  return { scenes, characters: r.data?.characters || [] };
};

export const upsertCharacters = async (owner: Types.ObjectId, projectId: Types.ObjectId, chapterNumber: number, list: any[]) => {
  for (const c of list || []) {
    const name = String(c?.name || '').trim();
    if (!name || name.length > 120) continue;
    const existing = await Character.findOne({ project: projectId, $or: [{ name }, { aliases: name }] }).collation({ locale: 'en', strength: 2 });
    if (existing) {
      const aliases = new Set([...existing.aliases, ...((c.aliases || []) as string[])].filter((a) => a && a !== existing.name));
      existing.aliases = [...aliases].slice(0, 20);
      existing.lastChapter = Math.max(existing.lastChapter || chapterNumber, chapterNumber);
      if (existing.source !== 'user') {
        existing.appearance = existing.appearance || c.appearance;
        existing.description = c.description || existing.description;
        existing.pronunciation = existing.pronunciation || c.pronunciation;
      }
      await existing.save();
    } else {
      await Character.create({
        owner,
        project: projectId,
        name,
        aliases: (c.aliases || []).slice(0, 20),
        appearance: c.appearance,
        description: c.description,
        pronunciation: c.pronunciation,
        firstChapter: chapterNumber,
        lastChapter: chapterNumber,
      }).catch(() => undefined);
    }
  }
};

const sceneThumbnail = async (img: IComicImageDocument, bbox: NBox, tempDir: string, projectId: Types.ObjectId, owner: Types.ObjectId) => {
  const local = await resolveLocal(img.file!, tempDir);
  const crop = await cropRegion(local, bbox, 480, 78);
  const webp = await openSharp(crop).resize({ width: 360, height: 640, fit: 'inside' }).webp({ quality: 75 }).toBuffer();
  return storeBuffer(webp, { tempDir, folder: projectFolder(projectId, 'scenes'), originalName: 'scene.webp', owner });
};

/** Re-analyse one scene's regions with the vision model (keeps its regions). */
const regenerateScene = async (ctx: JobContext<{ sceneId: string; force?: boolean }>) => {
  const scene = await DetectedScene.findById(ctx.payload.sceneId);
  if (!scene) throw new NonRetryableError('Scene no longer exists');
  if (scene.userEdited && !ctx.payload.force) {
    throw new NonRetryableError('This scene was edited by you — confirm to overwrite your changes', 'EDIT_LOCK');
  }
  const provider = getVisionProvider();
  if (!provider.configured) throw new NonRetryableError(`AI provider "${provider.name}" is not configured (missing API key on the server).`, 'AI_NOT_CONFIGURED');
  const project = await MangaProject.findById(scene.project);
  const tempDir = await makeTempDir('scene-regen');
  try {
    const images = new Map((await ComicImage.find({ _id: { $in: scene.regions.map((r) => r.image) } })).map((i) => [String(i._id), i]));
    const units: Unit[] = [];
    for (const r of [...scene.regions].sort((a, b) => a.order - b.order)) {
      const img = images.get(String(r.image));
      if (!img?.file) continue;
      const local = await resolveLocal(img.file, tempDir);
      const ratio = (r.bbox.height * img.height) / Math.max(1, r.bbox.width * img.width);
      units.push({ id: units.length + 1, image: img, bbox: r.bbox, tiles: ratio > TALL_PANEL_RATIO ? await tileRegion(local, r.bbox) : [{ data: await cropRegion(local, r.bbox), start: 0, end: 1 }] });
    }
    if (!units.length) throw new NonRetryableError('Scene has no readable source images');
    const characters = await knownCharacters(scene.project);
    const settings = await getSettings(scene.owner);
    await ctx.progress(10, 'Uploading scene panels');
    await uploadUnitTiles(ctx, units);
    await ctx.progress(20, 'Analysing scene panels');
    let segments: Segment[] | undefined;
    let grouped: { scenes: any[]; characters: any[] } | undefined;
    if (units.reduce((n, u) => n + u.tiles.length, 0) <= MAX_IMAGES_PER_REQUEST()) {
      const merged = await analyseAndGroup(ctx, units, { characters, continuity: project?.continuitySummary, chapterNumber: scene.chapterNumber, language: project?.language || 'en', narrationLanguage: settings.narrationLanguage, mode: settings.narrationMode });
      if (merged) {
        segments = merged.segments;
        grouped = merged.grouped;
      }
    }
    if (!segments || !grouped) {
      segments = await analyseUnits(ctx, units, { characters, continuity: project?.continuitySummary, language: project?.language || 'en' });
      await ctx.progress(70, 'Summarising scene');
      grouped = await groupSegments(ctx, segments.map((s, i) => ({ ...s, sceneStart: i === 0 })), { characters, continuity: project?.continuitySummary, chapterNumber: scene.chapterNumber, language: settings.narrationLanguage, mode: settings.narrationMode });
    }
    const sc = grouped.scenes[0] || {};
    scene.history.push({ at: new Date(), source: 'ai', note: 'before regenerate', data: snapshotScene(scene) });
    scene.set({
      title: sc.title || scene.title,
      characters: sc.characters?.length ? sc.characters : [...new Set(segments.flatMap((s) => s.characters))],
      location: sc.location,
      action: sc.action || segments.map((s) => s.action).filter(Boolean).join(' '),
      emotion: sc.emotion,
      description: sc.description || segments.map((s) => s.visualDescription).filter(Boolean).join(' '),
      events: sc.events?.length ? sc.events : segments.flatMap((s) => s.events),
      dialogues: [], // scenes stay visual-only; OCR is transient narration input
      storyContext: sc.storyContext,
      confidence: sc.confidence,
      source: 'ai',
      userEdited: false,
      version: scene.version + 1,
    });
    scene.history = scene.history.slice(-30);
    // Keep the linked narration segment in sync (same grouping call produced it).
    if (sc.narration) {
      const seg = await StorySegment.findOne({ scenes: scene._id, userEdited: false });
      if (seg) {
        const narration = String(sc.narration).trim();
        const words = narration.split(/\s+/u).filter(Boolean).length;
        seg.narration = narration;
        seg.title = sc.title || seg.title;
        seg.wordCount = words;
        seg.estimatedDuration = estimateSeconds(words, wordsPerMinute(settings, seg.language));
        seg.history.push({ at: new Date(), source: 'ai', note: 'regenerate', narration });
        seg.history = seg.history.slice(-40);
        await seg.save();
      }
    }
    await scene.save();
    await emitToUser(scene.owner, 'scenes:update', { chapter: String(scene.chapter), scene: String(scene._id) }, scene.project);
    return { sceneId: String(scene._id) };
  } finally {
    await removeDir(tempDir);
  }
};

export const snapshotScene = (s: any) => ({
  title: s.title,
  characters: s.characters,
  location: s.location,
  action: s.action,
  emotion: s.emotion,
  description: s.description,
  events: s.events,
  dialogues: s.dialogues,
  storyContext: s.storyContext,
  regions: s.regions,
  confidence: s.confidence,
});

registerJobHandler<{ chapterId?: string; sceneId?: string; force?: boolean; overwriteEdited?: boolean; redetectPanels?: boolean }>('scene-detection', async (ctx) => {
  if (ctx.payload.sceneId) return regenerateScene(ctx as any);
  const chapter = await MangaChapter.findById(ctx.payload.chapterId);
  if (!chapter) throw new NonRetryableError('Chapter no longer exists');
  if (chapter.status !== 'ready') throw new NonRetryableError('Chapter images are not extracted yet');
  const project = await MangaProject.findById(chapter.project);
  if (!project) throw new NonRetryableError('Project no longer exists');

  const edited = await DetectedScene.countDocuments({ chapter: chapter._id, userEdited: true });
  if (edited && !ctx.payload.overwriteEdited) {
    throw new NonRetryableError(`${edited} scene(s) in this chapter were edited by you. Confirm overwrite to re-detect, or regenerate individual scenes.`, 'EDIT_LOCK');
  }
  const provider = getVisionProvider();
  if (!provider.configured) throw new NonRetryableError(`AI provider "${provider.name}" is not configured (missing API key on the server).`, 'AI_NOT_CONFIGURED');

  chapter.analysisStatus = 'processing';
  await chapter.save();
  await emitToUser(chapter.owner, 'chapter:update', serializeChapter(chapter), chapter.project);

  const tempDir = await makeTempDir('scenes');
  try {
    const all = await ComicImage.find({ chapter: chapter._id }).sort({ index: 1 });
    const images = all.filter((i) => i.status !== 'broken' && i.file);
    const broken = all.filter((i) => i.status === 'broken');
    if (broken.length) await ctx.log(`${broken.length} broken page(s) excluded: ${broken.map((b) => b.index + 1).join(', ')} — fix them in the Pages tab and re-run`, 'warn');
    if (!images.length) throw new NonRetryableError('No readable pages in this chapter');

    await ctx.progress(2, 'Detecting panels');
    await ensurePanels(images, tempDir, project.language === 'ja', ctx.payload.redetectPanels);

    await ctx.progress(8, 'Preparing panel crops');
    const units: Unit[] = [];
    for (const img of images) {
      const local = await resolveLocal(img.file!, tempDir);
      for (const p of [...img.panels].sort((a, b) => a.order - b.order)) {
        const pxRatio = (p.bbox.height * img.height) / Math.max(1, p.bbox.width * img.width);
        const tiles = pxRatio > TALL_PANEL_RATIO ? await tileRegion(local, p.bbox) : [{ data: await cropRegion(local, p.bbox), start: 0, end: 1 }];
        units.push({ id: units.length + 1, image: img, bbox: p.bbox, tiles });
      }
    }
    await ctx.log(`${units.length} panel unit(s), ${units.reduce((n, u) => n + u.tiles.length, 0)} image tile(s) to analyse`);

    const characters = await knownCharacters(project._id as Types.ObjectId);
    const settings = await getSettings(project.owner);
    await uploadUnitTiles(ctx, units);
    const totalImages = units.reduce((n, u) => n + u.tiles.length, 0);
    let segments: Segment[] | undefined;
    let grouped: { scenes: any[]; characters: any[] } | undefined;
    if (totalImages <= MAX_IMAGES_PER_REQUEST()) {
      await ctx.progress(15, `Analysing ${units.length} units + writing narration (single call)`);
      const merged = await analyseAndGroup(ctx, units, { characters, continuity: project.continuitySummary, chapterNumber: chapter.number, language: project.language, narrationLanguage: settings.narrationLanguage, mode: settings.narrationMode });
      if (merged) {
        segments = merged.segments;
        grouped = merged.grouped;
        await ctx.progress(72, 'Analysis + scenes + narration done in one call');
      }
    }
    if (!segments || !grouped) {
      segments = await analyseUnits(ctx, units, { characters, continuity: project.continuitySummary, language: project.language });
      await ctx.progress(72, 'Grouping panels into scenes + narration');
      grouped = await groupSegments(ctx, segments, { characters, continuity: project.continuitySummary, chapterNumber: chapter.number, language: settings.narrationLanguage, mode: settings.narrationMode });
    }
    ctx.throwIfCancelled();

    // Replace previous scenes (edit-locked ones only when the user confirmed)
    await ctx.progress(85, 'Saving scenes');
    const old = await DetectedScene.find({ chapter: chapter._id });
    for (const s of old) await deleteFileById(s.thumbnail);
    await DetectedScene.deleteMany({ chapter: chapter._id });
    const sceneDocs = [];

    const segById = new Map(segments.map((s) => [s.id, s]));
    let order = 0;
    for (const sc of grouped.scenes) {
      const segs = (sc.segmentIds as number[]).map((id) => segById.get(Number(id))!).filter(Boolean);
      if (!segs.length) continue;
      order += 1;
      const thumb = await sceneThumbnail(segs[0].image, segs[0].bbox, tempDir, project._id as Types.ObjectId, chapter.owner).catch(() => undefined);
      const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter(Boolean) as string[])];
      sceneDocs.push(await DetectedScene.create({
        owner: chapter.owner,
        project: project._id,
        chapter: chapter._id,
        chapterNumber: chapter.number,
        order,
        regions: segs.map((s, i) => ({ image: s.image._id, bbox: s.bbox, order: i })),
        thumbnail: thumb?._id,
        title: sc.title || undefined,
        characters: uniq(sc.characters?.length ? sc.characters : segs.flatMap((s) => s.characters)),
        location: sc.location || uniq(segs.map((s) => s.location))[0],
        action: sc.action || segs.map((s) => s.action).filter(Boolean).join(' '),
        emotion: sc.emotion || uniq(segs.map((s) => s.emotion))[0],
        description: sc.description || segs.map((s) => s.visualDescription).filter(Boolean).join(' '),
        events: sc.events?.length ? sc.events : segs.flatMap((s) => s.events),
        storyContext: sc.storyContext,
        confidence: Number.isFinite(sc.confidence) ? Math.min(1, Math.max(0, sc.confidence)) : segs.reduce((n, s) => n + s.confidence, 0) / segs.length,
        source: 'ai',
        history: [{ at: new Date(), source: 'ai', note: 'detected' }],
        dialogues: [], // scenes stay visual-only; OCR text is transient input to the same-call narration
      }));
    }
    await upsertCharacters(chapter.owner, project._id as Types.ObjectId, chapter.number, grouped.characters);

    // Narration segments are written during the same grouping call — persist 1:1 with scenes.
    await ctx.progress(92, 'Saving narration');
    await StorySegment.deleteMany({ chapter: chapter._id, language: settings.narrationLanguage, mode: settings.narrationMode, userEdited: false });
    const wpm = wordsPerMinute(settings, settings.narrationLanguage);
    for (let i = 0; i < sceneDocs.length; i++) {
      const sc = grouped.scenes[i];
      const narration = String(sc?.narration || '').trim();
      const words = narration.split(/\s+/u).filter(Boolean).length;
      await StorySegment.create({
        owner: chapter.owner,
        project: project._id,
        chapter: chapter._id,
        chapterNumber: chapter.number,
        scenes: [sceneDocs[i]._id],
        order: i + 1,
        language: settings.narrationLanguage,
        mode: settings.narrationMode,
        title: sc?.title || sceneDocs[i].title,
        narration,
        emotion: sc?.emotion || sceneDocs[i].emotion,
        wordCount: words,
        estimatedDuration: estimateSeconds(words, wpm),
        confidence: sceneDocs[i].confidence,
        uncertainties: (sc?.uncertainties || []).slice(0, 10),
        history: [{ at: new Date(), source: 'ai', note: 'detected', narration }],
      });
    }
    chapter.storyStatus = 'done';
    await emitToUser(chapter.owner, 'story:update', { chapter: String(chapter._id), language: settings.narrationLanguage, mode: settings.narrationMode }, chapter.project);

    chapter.analysisStatus = 'done';
    await chapter.save();
    await emitToUser(chapter.owner, 'chapter:update', serializeChapter(chapter), chapter.project);
    await emitToUser(chapter.owner, 'scenes:update', { chapter: String(chapter._id) }, chapter.project);
    return { scenes: order, segments: segments.length, panels: units.length, brokenPagesExcluded: broken.length };
  } catch (error) {
    chapter.analysisStatus = 'failed';
    await chapter.save();
    await emitToUser(chapter.owner, 'chapter:update', serializeChapter(chapter), chapter.project);
    throw error;
  } finally {
    await removeDir(tempDir);
  }
});

