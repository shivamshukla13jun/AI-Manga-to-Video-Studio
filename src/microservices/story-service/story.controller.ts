import { Request } from 'express';
import { Types } from 'mongoose';
import { AppError } from 'middlewares/error';
import MangaChapter from 'models/manga-chapter.model';
import ComicImage, { IComicImageDocument } from 'models/comic-image.model';
import DetectedScene, { IDetectedSceneDocument } from 'models/detected-scene.model';
import StorySegment, { IStorySegmentDocument } from 'models/story-segment.model';
import Character from 'models/character.model';
import CostEstimate from 'models/cost-estimate.model';
import { asyncHandler, assertObjectId, notFound, ok, ownerFilter } from 'libs/studio/http';
import { enqueueJob, serializeJob } from 'libs/jobs/job.service';
import { approveEstimate, serializeEstimate } from 'libs/pricing/estimator';
import { getSettings } from 'libs/pricing/pricing.service';
import { deleteFileById } from 'libs/studio/media';
import { countWords } from 'libs/ai/prompts';
import { getVisionProvider } from 'libs/ai/provider';
import { getChapter, getProject } from 'microservices/manga-service/manga.service';
import { estimateSeconds, wordsPerMinute } from 'workers/processors/story.processor';
import { snapshotScene } from 'workers/processors/scene.processor';
import { serializeCharacter, serializeScene, serializeSegment } from './story.serializers';
import { estimateSceneDetection, estimateStory } from './story.estimates';

// ---------------------------------------------------------------- helpers
const getScene = async (req: Request, id: unknown) => {
  const s = await DetectedScene.findOne({ _id: assertObjectId(id, 'scene id'), ...ownerFilter(req) });
  if (!s) throw notFound('Scene');
  return s;
};
const getSegment = async (req: Request, id: unknown) => {
  const s = await StorySegment.findOne({ _id: assertObjectId(id, 'segment id'), ...ownerFilter(req) });
  if (!s) throw notFound('Narration segment');
  return s;
};

const imageMap = async (scenes: IDetectedSceneDocument[]) => {
  const ids = [...new Set(scenes.flatMap((s) => s.regions.map((r) => String(r.image))))];
  const images = await ComicImage.find({ _id: { $in: ids } }).select('index file thumbnail width height');
  return new Map<string, IComicImageDocument>(images.map((i) => [String(i._id), i]));
};

const pushSceneHistory = (scene: IDetectedSceneDocument, note: string) => {
  scene.history.push({ at: new Date(), source: 'user', note, data: snapshotScene(scene) });
  scene.history = scene.history.slice(-30);
};

const assertChapterScenes = (scenes: IDetectedSceneDocument[]) => {
  const chapter = String(scenes[0].chapter);
  if (!scenes.every((s) => String(s.chapter) === chapter)) throw new AppError('Scenes must belong to the same chapter', 400);
};

/** Validate that region images belong to the project. */
const assertRegionImages = async (projectId: Types.ObjectId, regions: { image: string }[]) => {
  const ids = [...new Set(regions.map((r) => r.image))];
  const count = await ComicImage.countDocuments({ _id: { $in: ids }, project: projectId });
  if (count !== ids.length) throw new AppError('Region images must belong to this project', 400);
};

const renumberScenes = async (chapterId: Types.ObjectId) => {
  const scenes = await DetectedScene.find({ chapter: chapterId }).sort({ order: 1 }).select('_id');
  await DetectedScene.bulkWrite(scenes.map((s, i) => ({ updateOne: { filter: { _id: s._id }, update: { $set: { order: i + 1 } } } })));
};

const touchSegment = async (seg: IStorySegmentDocument, narration: string, note: string, source: 'user' | 'ai' = 'user') => {
  const settings = await getSettings(seg.owner);
  const words = countWords(narration);
  seg.narration = narration;
  seg.wordCount = words;
  seg.estimatedDuration = estimateSeconds(words, wordsPerMinute(settings, seg.language));
  seg.history.push({ at: new Date(), source, note, title: seg.title, narration });
  seg.history = seg.history.slice(-40);
  seg.version += 1;
};

// ------------------------------------------------------------- overview
export const projectOverview = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const settings = await getSettings(project.owner);
  const language = String(req.query.language || settings.narrationLanguage);
  const mode = String(req.query.mode || settings.narrationMode);
  const chapters = await MangaChapter.find({ project: project._id }).sort({ number: 1, order: 1 });
  const sceneCounts = await DetectedScene.aggregate([
    { $match: { project: project._id } },
    { $group: { _id: '$chapter', scenes: { $sum: 1 }, edited: { $sum: { $cond: ['$userEdited', 1, 0] } } } },
  ]);
  const segCounts = await StorySegment.aggregate([
    { $match: { project: project._id, language, mode } },
    { $group: { _id: '$chapter', segments: { $sum: 1 }, words: { $sum: '$wordCount' }, duration: { $sum: '$estimatedDuration' }, edited: { $sum: { $cond: ['$userEdited', 1, 0] } } } },
  ]);
  const sc = new Map(sceneCounts.map((s) => [String(s._id), s]));
  const sg = new Map(segCounts.map((s) => [String(s._id), s]));
  ok(res, {
    project: { id: String(project._id), title: project.title, narrationLanguage: language, narrationMode: mode, continuitySummary: project.continuitySummary, continuityThrough: project.continuityThrough },
    aiConfigured: getVisionProvider().configured,
    language,
    mode,
    chapters: chapters.map((c) => ({
      id: String(c._id),
      number: c.number,
      title: c.title,
      status: c.status,
      imageCount: c.imageCount,
      brokenImageCount: c.brokenImageCount,
      analysisStatus: c.analysisStatus,
      storyStatus: c.storyStatus,
      summary: c.summary,
      scenes: sc.get(String(c._id))?.scenes || 0,
      editedScenes: sc.get(String(c._id))?.edited || 0,
      segments: sg.get(String(c._id))?.segments || 0,
      editedSegments: sg.get(String(c._id))?.edited || 0,
      words: sg.get(String(c._id))?.words || 0,
      duration: sg.get(String(c._id))?.duration || 0,
    })),
  });
});

// -------------------------------------------------------------- estimates
export const estimateScenes = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.body.projectId);
  const est = await estimateSceneDetection(project.owner, project._id as Types.ObjectId, req.body.chapterIds);
  ok(res, await serializeEstimate(est), 201);
});

export const estimateNarration = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.body.projectId);
  const settings = await getSettings(project.owner);
  const language = req.body.language || settings.narrationLanguage;
  const mode = req.body.mode || settings.narrationMode;
  const est = await estimateStory(project.owner, project._id as Types.ObjectId, req.body.chapterIds, language, mode);
  ok(res, await serializeEstimate(est), 201);
});

export const getEstimate = asyncHandler(async (req, res) => {
  const est = await CostEstimate.findOne({ _id: assertObjectId(req.params.estimateId), ...ownerFilter(req) });
  if (!est) throw notFound('Estimate');
  ok(res, await serializeEstimate(est));
});

export const listEstimates = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const list = await CostEstimate.find({ project: project._id, approvedAt: { $exists: true } }).sort({ createdAt: -1 }).limit(50);
  ok(res, await Promise.all(list.map(serializeEstimate)));
});

// ------------------------------------------------------------- AI jobs
export const detectScenes = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.body.projectId);
  const chapters = await MangaChapter.find({ _id: { $in: req.body.chapterIds }, project: project._id }).sort({ number: 1 });
  if (chapters.length !== req.body.chapterIds.length) throw new AppError('Some chapters were not found in this project', 400);
  const notReady = chapters.filter((c) => c.status !== 'ready');
  if (notReady.length) throw new AppError(`Chapter(s) ${notReady.map((c) => c.number).join(', ')} are not extracted yet`, 400);
  const est = await approveEstimate(project.owner, req.body.estimateId, 'scene-detection', { chapterIds: req.body.chapterIds });
  const jobs = [];
  for (const c of chapters) {
    jobs.push(
      await enqueueJob({
        type: 'scene-detection',
        owner: project.owner,
        project: project._id as Types.ObjectId,
        title: `Detect scenes — Chapter ${c.number}`,
        payload: { chapterId: String(c._id), overwriteEdited: req.body.overwriteEdited, redetectPanels: req.body.redetectPanels, estimateId: String(est._id) },
        target: { kind: 'chapter', id: c._id as Types.ObjectId },
        idempotencyKey: `scenes:${c._id}`,
      })
    );
  }
  est.job = jobs[0]._id as Types.ObjectId;
  await est.save();
  ok(res, jobs.map((j) => serializeJob(j)), 202);
});

export const generateStory = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.body.projectId);
  const { chapterIds } = req.body;
  const settings = await getSettings(project.owner);
  const language = req.body.language || settings.narrationLanguage;
  const mode = req.body.mode || settings.narrationMode;
  const count = await MangaChapter.countDocuments({ _id: { $in: chapterIds }, project: project._id });
  if (count !== chapterIds.length) throw new AppError('Some chapters were not found in this project', 400);
  const est = await approveEstimate(project.owner, req.body.estimateId, 'story-generation', { chapterIds, language, mode });
  const job = await enqueueJob({
    type: 'story-generation',
    owner: project.owner,
    project: project._id as Types.ObjectId,
    title: `Write ${mode} narration (${language}) — ${chapterIds.length} chapter(s)`,
    payload: { projectId: String(project._id), chapterIds, language, mode, overwriteEdited: req.body.overwriteEdited, estimateId: String(est._id) },
    target: { kind: 'project', id: project._id as Types.ObjectId },
    idempotencyKey: `story:${project._id}:${language}:${mode}`,
  });
  est.job = job._id as Types.ObjectId;
  await est.save();
  ok(res, serializeJob(job), 202);
});

export const regenerateScene = asyncHandler(async (req, res) => {
  const scene = await getScene(req, req.params.sceneId);
  if (scene.userEdited && !req.body.force) throw new AppError('This scene was edited by you — confirm to overwrite your changes', 409, { editLock: true });
  const job = await enqueueJob({
    type: 'scene-detection',
    owner: scene.owner,
    project: scene.project,
    title: `Regenerate scene ${scene.order} — Chapter ${scene.chapterNumber}`,
    payload: { sceneId: String(scene._id), force: req.body.force },
    target: { kind: 'scene', id: scene._id as Types.ObjectId },
    idempotencyKey: `scene:${scene._id}`,
  });
  ok(res, serializeJob(job), 202);
});

export const rewriteSegment = asyncHandler(async (req, res) => {
  const seg = await getSegment(req, req.params.segmentId);
  if (req.body.action === 'regenerate' && seg.userEdited && !req.body.force) {
    throw new AppError('This narration was edited by you — confirm to overwrite it', 409, { editLock: true });
  }
  const job = await enqueueJob({
    type: 'story-generation',
    owner: seg.owner,
    project: seg.project,
    title: `${req.body.action} narration — Chapter ${seg.chapterNumber} #${seg.order}`,
    payload: { segmentId: String(seg._id), action: req.body.action, tone: req.body.tone, language: req.body.language, force: req.body.force },
    target: { kind: 'segment', id: seg._id as Types.ObjectId },
    idempotencyKey: `segment:${seg._id}`,
  });
  ok(res, serializeJob(job), 202);
});

// ---------------------------------------------------------------- scenes
export const listChapterScenes = asyncHandler(async (req, res) => {
  const chapter = await getChapter(req, req.params.chapterId);
  const scenes = await DetectedScene.find({ chapter: chapter._id }).sort({ order: 1 });
  const images = await imageMap(scenes);
  ok(res, scenes.map((s) => serializeScene(s, images)));
});

export const updateScene = asyncHandler(async (req, res) => {
  const scene = await getScene(req, req.params.sceneId);
  if (req.body.regions) await assertRegionImages(scene.project, req.body.regions);
  pushSceneHistory(scene, 'before edit');
  const { regions, ...fields } = req.body;
  scene.set(fields);
  if (regions) scene.regions = regions.map((r: any, i: number) => ({ image: r.image, bbox: r.bbox, order: r.order ?? i }));
  scene.userEdited = true;
  scene.version += 1;
  await scene.save();
  ok(res, serializeScene(scene, await imageMap([scene])));
});

export const createScene = asyncHandler(async (req, res) => {
  const chapter = await getChapter(req, req.params.chapterId);
  await assertRegionImages(chapter.project, req.body.regions);
  let order = 1;
  if (req.body.afterSceneId) {
    const after = await DetectedScene.findOne({ _id: req.body.afterSceneId, chapter: chapter._id });
    if (!after) throw notFound('Scene to insert after');
    order = after.order + 0.5;
  } else {
    const last = await DetectedScene.findOne({ chapter: chapter._id }).sort({ order: -1 });
    order = (last?.order || 0) + 1;
  }
  const { afterSceneId: _a, regions, ...fields } = req.body;
  const scene = await DetectedScene.create({
    ...fields,
    owner: chapter.owner,
    project: chapter.project,
    chapter: chapter._id,
    chapterNumber: chapter.number,
    order,
    regions: regions.map((r: any, i: number) => ({ image: r.image, bbox: r.bbox, order: i })),
    source: 'user',
    userEdited: true,
    history: [{ at: new Date(), source: 'user', note: 'created manually' }],
  });
  await renumberScenes(chapter._id as Types.ObjectId);
  const fresh = await DetectedScene.findById(scene._id);
  ok(res, serializeScene(fresh!, await imageMap([fresh!])), 201);
});

/** Merge adjacent scenes into the first; narration segments are re-pointed. */
export const mergeScenes = asyncHandler(async (req, res) => {
  const scenes = await DetectedScene.find({ _id: { $in: req.body.ids }, ...ownerFilter(req) }).sort({ order: 1 });
  if (scenes.length !== req.body.ids.length) throw notFound('Scene');
  assertChapterScenes(scenes);
  const all = await DetectedScene.find({ chapter: scenes[0].chapter }).sort({ order: 1 }).select('_id');
  const idx = scenes.map((s) => all.findIndex((a) => String(a._id) === String(s._id)));
  if (!idx.every((v, i) => i === 0 || v === idx[i - 1] + 1)) throw new AppError('Only adjacent scenes can be merged', 400);

  const [first, ...rest] = scenes;
  pushSceneHistory(first, `before merge with ${rest.length} scene(s)`);
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  first.regions = scenes.flatMap((s) => s.regions).map((r, i) => ({ image: r.image, bbox: r.bbox, order: i }));
  first.dialogues = scenes.flatMap((s) => s.dialogues);
  first.events = scenes.flatMap((s) => s.events);
  first.characters = uniq(scenes.flatMap((s) => s.characters));
  first.description = scenes.map((s) => s.description).filter(Boolean).join(' ');
  first.action = scenes.map((s) => s.action).filter(Boolean).join(' ');
  first.userEdited = true;
  first.version += 1;
  await first.save();

  const restIds = rest.map((s) => s._id);
  const segs = await StorySegment.find({ scenes: { $in: restIds } });
  for (const seg of segs) {
    const ids = seg.scenes.map((id) => (restIds.some((r) => String(r) === String(id)) ? first._id : id)) as Types.ObjectId[];
    seg.scenes = ids.filter((id, i) => ids.findIndex((x) => String(x) === String(id)) === i);
    await seg.save();
  }
  for (const s of rest) await deleteFileById(s.thumbnail);
  await DetectedScene.deleteMany({ _id: { $in: restIds } });
  await renumberScenes(first.chapter);
  const fresh = await DetectedScene.findById(first._id);
  ok(res, serializeScene(fresh!, await imageMap([fresh!])));
});

/** Split a scene by region list or by cutting one region at a vertical position. */
export const splitScene = asyncHandler(async (req, res) => {
  const scene = await getScene(req, req.params.sceneId);
  const regions = [...scene.regions].sort((a, b) => a.order - b.order);
  let firstPart: typeof regions;
  let secondPart: typeof regions;
  if (req.body.regionIndex !== undefined && regions.length > 1) {
    if (req.body.regionIndex >= regions.length) throw new AppError('regionIndex out of range', 400);
    firstPart = regions.slice(0, req.body.regionIndex);
    secondPart = regions.slice(req.body.regionIndex);
  } else if (req.body.atY !== undefined && regions.length === 1) {
    const r = regions[0];
    const cut = r.bbox.height * req.body.atY;
    firstPart = [{ image: r.image, order: 0, bbox: { ...r.bbox, height: cut } }];
    secondPart = [{ image: r.image, order: 0, bbox: { ...r.bbox, y: r.bbox.y + cut, height: r.bbox.height - cut } }];
  } else {
    throw new AppError(regions.length > 1 ? 'Provide regionIndex to split between regions' : 'Provide atY to cut the region', 400);
  }
  pushSceneHistory(scene, 'before split');
  scene.regions = firstPart.map((r, i) => ({ ...r, order: i })) as any;
  scene.userEdited = true;
  scene.version += 1;
  await scene.save();
  const created = await DetectedScene.create({
    owner: scene.owner,
    project: scene.project,
    chapter: scene.chapter,
    chapterNumber: scene.chapterNumber,
    order: scene.order + 0.5,
    regions: secondPart.map((r, i) => ({ image: r.image, bbox: r.bbox, order: i })),
    title: scene.title ? `${scene.title} (cont.)` : undefined,
    characters: scene.characters,
    location: scene.location,
    emotion: scene.emotion,
    source: 'user',
    userEdited: true,
    history: [{ at: new Date(), source: 'user', note: `split from scene ${scene.order}` }],
  });
  // narration that covered the scene now covers both parts
  const segs = await StorySegment.find({ scenes: scene._id });
  for (const seg of segs) {
    const i = seg.scenes.findIndex((id) => String(id) === String(scene._id));
    seg.scenes.splice(i + 1, 0, created._id as Types.ObjectId);
    await seg.save();
  }
  await renumberScenes(scene.chapter);
  const both = await DetectedScene.find({ _id: { $in: [scene._id, created._id] } }).sort({ order: 1 });
  const images = await imageMap(both);
  ok(res, both.map((s) => serializeScene(s, images)));
});

export const deleteScene = asyncHandler(async (req, res) => {
  const scene = await getScene(req, req.params.sceneId);
  const segs = await StorySegment.find({ scenes: scene._id });
  for (const seg of segs) {
    seg.scenes = seg.scenes.filter((id) => String(id) !== String(scene._id));
    if (seg.scenes.length) await seg.save();
    else await seg.deleteOne();
  }
  await deleteFileById(scene.thumbnail);
  await scene.deleteOne();
  await renumberScenes(scene.chapter);
  ok(res, { id: String(scene._id) });
});

export const reorderScenes = asyncHandler(async (req, res) => {
  const chapter = await getChapter(req, req.params.chapterId);
  const ids: string[] = req.body.ids;
  const total = await DetectedScene.countDocuments({ chapter: chapter._id });
  const count = await DetectedScene.countDocuments({ chapter: chapter._id, _id: { $in: ids } });
  if (count !== ids.length || total !== ids.length) throw new AppError('ids must list every scene of the chapter once', 400);
  await DetectedScene.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: i + 1, userEdited: true } } } })));
  ok(res, { ids });
});

export const restoreScene = asyncHandler(async (req, res) => {
  const scene = await getScene(req, req.params.sceneId);
  const snap = scene.history[req.body.historyIndex];
  if (!snap?.data) throw new AppError('That version has no stored content', 400);
  const data = snap.data as any;
  pushSceneHistory(scene, `before restore of version ${req.body.historyIndex}`);
  scene.set({ ...data, regions: data.regions || scene.regions, userEdited: true, version: scene.version + 1 });
  await scene.save();
  ok(res, serializeScene(scene, await imageMap([scene])));
});

/** User-drawn panels for a page (locks them against CV re-detection). */
export const updatePanels = asyncHandler(async (req, res) => {
  const image = await ComicImage.findOne({ _id: assertObjectId(req.params.imageId), ...ownerFilter(req) });
  if (!image) throw notFound('Image');
  image.panels = req.body.panels.map((bbox: any, order: number) => ({ bbox, order, source: 'user' })) as any;
  image.panelsDetectedAt = new Date();
  await image.save();
  ok(res, { id: String(image._id), panels: image.panels });
});

// -------------------------------------------------------------- segments
export const listSegments = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const s = await getSettings(project.owner);
  const language = String(req.query.language || s.narrationLanguage);
  const mode = String(req.query.mode || s.narrationMode);
  const filter: Record<string, unknown> = { project: project._id, language, mode };
  if (req.query.chapter) filter.chapter = assertObjectId(req.query.chapter, 'chapter id');
  const segs = await StorySegment.find(filter).sort({ chapterNumber: 1, order: 1 });
  ok(res, segs.map(serializeSegment));
});

export const updateSegment = asyncHandler(async (req, res) => {
  const seg = await getSegment(req, req.params.segmentId);
  if (req.body.title !== undefined) seg.title = req.body.title;
  await touchSegment(seg, req.body.narration ?? seg.narration, 'edited');
  seg.userEdited = true;
  await seg.save();
  ok(res, serializeSegment(seg));
});

export const mergeSegments = asyncHandler(async (req, res) => {
  const segs = await StorySegment.find({ _id: { $in: req.body.ids }, ...ownerFilter(req) }).sort({ order: 1 });
  if (segs.length !== req.body.ids.length) throw notFound('Narration segment');
  const key = (s: IStorySegmentDocument) => `${s.chapter}:${s.language}:${s.mode}`;
  if (!segs.every((s) => key(s) === key(segs[0]))) throw new AppError('Segments must be in the same chapter, language and mode', 400);
  const siblings = await StorySegment.find({ chapter: segs[0].chapter, language: segs[0].language, mode: segs[0].mode }).sort({ order: 1 }).select('_id');
  const idx = segs.map((s) => siblings.findIndex((x) => String(x._id) === String(s._id)));
  if (!idx.every((v, i) => i === 0 || v === idx[i - 1] + 1)) throw new AppError('Only adjacent segments can be merged', 400);
  const [first, ...rest] = segs;
  const sceneIds = segs.flatMap((s) => s.scenes.map(String));
  first.scenes = [...new Set(sceneIds)].map((id) => new Types.ObjectId(id));
  first.uncertainties = segs.flatMap((s) => s.uncertainties);
  await touchSegment(first, segs.map((s) => s.narration.trim()).join(' '), `merged ${segs.length} segments`);
  first.userEdited = true;
  await first.save();
  await StorySegment.deleteMany({ _id: { $in: rest.map((s) => s._id) } });
  ok(res, serializeSegment(first));
});

export const splitSegment = asyncHandler(async (req, res) => {
  const seg = await getSegment(req, req.params.segmentId);
  const at = req.body.at;
  if (at >= seg.narration.length) throw new AppError('Split position must be inside the narration', 400);
  const a = seg.narration.slice(0, at).trim();
  const b = seg.narration.slice(at).trim();
  if (!a || !b) throw new AppError('Both parts must contain text', 400);
  const k = req.body.sceneSplitIndex;
  const scenesA = k && seg.scenes.length > 1 ? seg.scenes.slice(0, k) : seg.scenes;
  const scenesB = k && seg.scenes.length > 1 ? seg.scenes.slice(k) : seg.scenes;
  await StorySegment.updateMany({ chapter: seg.chapter, language: seg.language, mode: seg.mode, order: { $gt: seg.order } }, { $inc: { order: 1 } });
  seg.scenes = scenesA;
  await touchSegment(seg, a, 'split');
  seg.userEdited = true;
  await seg.save();
  const settings = await getSettings(seg.owner);
  const words = countWords(b);
  const created = await StorySegment.create({
    owner: seg.owner,
    project: seg.project,
    chapter: seg.chapter,
    chapterNumber: seg.chapterNumber,
    scenes: scenesB,
    order: seg.order + 1,
    language: seg.language,
    mode: seg.mode,
    title: seg.title ? `${seg.title} (2)` : undefined,
    narration: b,
    emotion: seg.emotion,
    wordCount: words,
    estimatedDuration: estimateSeconds(words, wordsPerMinute(settings, seg.language)),
    userEdited: true,
    history: [{ at: new Date(), source: 'user', note: 'split', narration: b }],
  });
  ok(res, [serializeSegment(seg), serializeSegment(created)]);
});

export const reorderSegments = asyncHandler(async (req, res) => {
  const segs = await StorySegment.find({ _id: { $in: req.body.ids }, ...ownerFilter(req) });
  if (segs.length !== req.body.ids.length) throw notFound('Narration segment');
  const key = (s: IStorySegmentDocument) => `${s.chapter}:${s.language}:${s.mode}`;
  if (!segs.every((s) => key(s) === key(segs[0]))) throw new AppError('Reorder within one chapter, language and mode', 400);
  await StorySegment.bulkWrite(req.body.ids.map((id: string, i: number) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: i + 1 } } } })));
  ok(res, { ids: req.body.ids });
});

export const deleteSegment = asyncHandler(async (req, res) => {
  const seg = await getSegment(req, req.params.segmentId);
  await seg.deleteOne();
  ok(res, { id: String(seg._id) });
});

export const restoreSegment = asyncHandler(async (req, res) => {
  const seg = await getSegment(req, req.params.segmentId);
  const snap = seg.history[req.body.historyIndex];
  if (!snap) throw new AppError('Version not found', 400);
  if (snap.title) seg.title = snap.title;
  await touchSegment(seg, snap.narration, `restored version ${req.body.historyIndex}`);
  seg.userEdited = true;
  await seg.save();
  ok(res, serializeSegment(seg));
});

// ------------------------------------------------------------ characters
export const listCharacters = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const chars = await Character.find({ project: project._id }).sort({ firstChapter: 1, name: 1 });
  ok(res, chars.map(serializeCharacter));
});

export const createCharacter = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const c = await Character.create({ ...req.body, owner: project.owner, project: project._id, source: 'user' });
  ok(res, serializeCharacter(c), 201);
});

export const updateCharacter = asyncHandler(async (req, res) => {
  const c = await Character.findOne({ _id: assertObjectId(req.params.characterId), ...ownerFilter(req) });
  if (!c) throw notFound('Character');
  c.set({ ...req.body, source: 'user' });
  await c.save();
  ok(res, serializeCharacter(c));
});

export const deleteCharacter = asyncHandler(async (req, res) => {
  const c = await Character.findOne({ _id: assertObjectId(req.params.characterId), ...ownerFilter(req) });
  if (!c) throw notFound('Character');
  await c.deleteOne();
  ok(res, { id: String(c._id) });
});
