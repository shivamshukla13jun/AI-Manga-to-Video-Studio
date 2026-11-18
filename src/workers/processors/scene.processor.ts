import { Types } from 'mongoose';
import MangaProject from 'models/manga-project.model';
import MangaChapter from 'models/manga-chapter.model';
import ComicImage, { IComicImageDocument } from 'models/comic-image.model';
import DetectedScene from 'models/detected-scene.model';
import Character from 'models/character.model';
import { registerJobHandler, NonRetryableError, JobContext } from 'libs/jobs/runner';
import { cropRegion, detectPanels, NBox } from 'libs/studio/panels';
import { deleteFileById, resolveLocal } from 'libs/studio/media';
import { makeTempDir, removeDir } from 'libs/studio/paths';
import { emitToUser } from 'libs/realtime/events';
import { serializeChapter } from 'microservices/manga-service/manga.serializers';

/**
 * Scene detection always runs on the Python CV service (free, no AI calls).
 * The aiProvider setting only controls story generation.
 * Every detected panel becomes one scene; users merge panels into story
 * beats in the scene editor.
 */

/** Ensure every usable page has panels. User-edited panels are never replaced. */
export const ensurePanels = async (
  images: IComicImageDocument[],
  tempDir: string,
  rtl: boolean,
  force = false,
  ctx?: JobContext
) => {
  for (const img of images) {
    if (!img.file || img.status === 'broken') continue;
    if (img.panels.some((p) => p.source === 'user')) continue;
    if (img.panels.length && img.panelsDetectedAt && !force) continue;
    const local = await resolveLocal(img.file, tempDir);
    const boxes: NBox[] = await detectPanels(local, { rtl });
    const source = 'cv' as const;
    img.panels = (boxes.length ? boxes : [{ x: 0, y: 0, width: 1, height: 1 }]).map((bbox, order) => ({ bbox, order, source })) as any;
    img.panelsDetectedAt = new Date();
    await img.save();
  }
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

/** Re-detect panels inside one scene's regions with the CV detector. */
const regenerateScene = async (ctx: JobContext<{ sceneId: string; force?: boolean }>) => {
  const scene = await DetectedScene.findById(ctx.payload.sceneId);
  if (!scene) throw new NonRetryableError('Scene no longer exists');
  if (scene.userEdited && !ctx.payload.force) {
    throw new NonRetryableError('This scene was edited by you — confirm to overwrite your changes', 'EDIT_LOCK');
  }
  const project = await MangaProject.findById(scene.project);
  const tempDir = await makeTempDir('scene-regen');
  try {
    const images = new Map((await ComicImage.find({ _id: { $in: scene.regions.map((r) => r.image) } })).map((i) => [String(i._id), i]));
    const regions: { image: Types.ObjectId; bbox: NBox; order: number }[] = [];
    await ctx.progress(20, 'Re-detecting panels');
    for (const r of [...scene.regions].sort((a, b) => a.order - b.order)) {
      const img = images.get(String(r.image));
      if (!img?.file) continue;
      const local = await resolveLocal(img.file, tempDir);
      // Detect sub-panels inside the region crop, mapped back to image coordinates.
      const crop = await cropRegion(local, r.bbox);
      const sub = await detectPanels(crop, { rtl: project?.language === 'ja' });
      const boxes = sub.length > 1 ? sub.map((b) => ({ x: r.bbox.x + b.x * r.bbox.width, y: r.bbox.y + b.y * r.bbox.height, width: b.width * r.bbox.width, height: b.height * r.bbox.height })) : [r.bbox];
      for (const b of boxes) regions.push({ image: img._id as Types.ObjectId, bbox: b, order: regions.length });
    }
    if (!regions.length) throw new NonRetryableError('Scene has no readable source images');
    scene.history.push({ at: new Date(), source: 'cv', note: 'before re-detect', data: snapshotScene(scene) });
    scene.regions = regions as any;
    if (scene.thumbnail) await deleteFileById(scene.thumbnail);
    scene.thumbnail = undefined;
    scene.version += 1;
    scene.userEdited = false;
    scene.source = 'cv';
    scene.history = scene.history.slice(-30);
    await scene.save();
    await ctx.progress(90, 'Scene updated');
    await emitToUser(scene.owner, 'scenes:update', { chapter: String(scene.chapter), scene: String(scene._id) }, scene.project);
    return { sceneId: String(scene._id), regions: regions.length };
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
  if (ctx.payload.sceneId) return regenerateScene(ctx as JobContext<{ sceneId: string; force?: boolean }>);

  const chapter = await MangaChapter.findById(ctx.payload.chapterId);
  if (!chapter) throw new NonRetryableError('Chapter no longer exists');
  const project = await MangaProject.findById(chapter.project);
  if (!project) throw new NonRetryableError('Project no longer exists');
  const tempDir = await makeTempDir('scenes');
  chapter.analysisStatus = 'processing';
  await chapter.save();
  try {
    const all = await ComicImage.find({ chapter: chapter._id }).sort({ index: 1 });
    const images = all.filter((i) => i.status !== 'broken' && i.file);
    const broken = all.filter((i) => i.status === 'broken');
    if (broken.length) await ctx.log(`${broken.length} broken page(s) excluded: ${broken.map((b) => b.index + 1).join(', ')} — fix them in the Pages tab and re-run`, 'warn');
    if (!images.length) throw new NonRetryableError('No readable pages in this chapter');

    await ctx.progress(5, 'Detecting panels (local CV)');
    await ensurePanels(images, tempDir, project.language === 'ja', ctx.payload.redetectPanels, ctx);
    ctx.throwIfCancelled();

    // Replace previous scenes (edit-locked ones only when the user confirmed)
    await ctx.progress(40, 'Saving scenes');
    const old = await DetectedScene.find({ chapter: chapter._id });
    for (const s of old) await deleteFileById(s.thumbnail);
    await DetectedScene.deleteMany({ chapter: chapter._id });

    let order = 0;
    let panels = 0;
    const total = images.reduce((n, i) => n + i.panels.length, 0) || 1;
    for (const img of images) {
      for (const p of [...img.panels].sort((a, b) => a.order - b.order)) {
        ctx.throwIfCancelled();
        order += 1;
        panels += 1;
        await DetectedScene.create({
          owner: chapter.owner,
          project: project._id,
          chapter: chapter._id,
          chapterNumber: chapter.number,
          order,
          regions: [{ image: img._id, bbox: p.bbox, order: 0 }],
          title: `Scene ${order}`,
          dialogues: [],
          confidence: 1,
          source: 'cv',
          history: [{ at: new Date(), source: 'cv', note: 'detected' }],
        });
        await ctx.progress(40 + (55 * panels) / total, `Scene ${order} of ${total}`);
      }
    }

    chapter.analysisStatus = 'done';
    await chapter.save();
    await emitToUser(chapter.owner, 'chapter:update', serializeChapter(chapter), chapter.project);
    await emitToUser(chapter.owner, 'scenes:update', { chapter: String(chapter._id) }, chapter.project);
    return { scenes: order, panels, brokenPagesExcluded: broken.length };
  } catch (error) {
    chapter.analysisStatus = 'failed';
    await chapter.save();
    await emitToUser(chapter.owner, 'chapter:update', serializeChapter(chapter), chapter.project);
    throw error;
  } finally {
    await removeDir(tempDir);
  }
});
