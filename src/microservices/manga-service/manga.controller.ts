import logger from 'utils/logger';
import { enrichFromPublicApi } from './metadata.service';
import path from 'path';
import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { AppError } from 'middlewares/error';
import MangaProject from 'models/manga-project.model';
import MangaChapter from 'models/manga-chapter.model';
import ComicImage from 'models/comic-image.model';
import ChapterGroup from 'models/chapter-group.model';
import UploadSession from 'models/upload-session.model';
import ProcessingJob from 'models/processing-job.model';
import { asyncHandler, assertObjectId, notFound, ok, ownerFilter, parseIntQuery } from 'libs/studio/http';
import { uploadedFile } from 'libs/studio/diskUpload';
import { deleteFileById, projectFolder, storeLocalFile } from 'libs/studio/media';
import { makeTempDir, removeDir } from 'libs/studio/paths';
import { probeAndThumbnail, isTallImage, openSharp } from 'libs/studio/images';
import { enqueueJob, serializeJob } from 'libs/jobs/job.service';
import {
  abortUpload,
  completeUpload,
  createUploadSession,
  deleteChapter,
  deleteProject,
  emitChapter,
  enqueueExtraction,
  getChapter,
  getImage,
  getProject,
  getUploadSession,
  writeChunk,
} from './manga.service';
import { serializeChapter, serializeGroup, serializeImage, serializeProject, serializeUpload } from './manga.serializers';

// ---------------------------------------------------------------- projects
const projectStats = async (projectIds: Types.ObjectId[]) => {
  const rows = await MangaChapter.aggregate([
    { $match: { project: { $in: projectIds } } },
    {
      $group: {
        _id: '$project',
        chapters: { $sum: 1 },
        ready: { $sum: { $cond: [{ $eq: ['$status', 'ready'] }, 1, 0] } },
        images: { $sum: '$imageCount' },
        stories: { $sum: { $cond: [{ $eq: ['$storyStatus', 'done'] }, 1, 0] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), { chapters: r.chapters, ready: r.ready, images: r.images, stories: r.stories }]));
};

export const listProjects = asyncHandler(async (req, res) => {
  const filter: Record<string, unknown> = { ...ownerFilter(req) };
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.search) filter.title = { $regex: String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const projects = await MangaProject.find(filter).sort({ updatedAt: -1 }).limit(parseIntQuery(req.query.limit, 100, 500));
  const stats = await projectStats(projects.map((p) => p._id as Types.ObjectId));
  ok(res, projects.map((p) => serializeProject(p, stats.get(String(p._id)) || { chapters: 0, ready: 0, images: 0, stories: 0 })));
});

export const createProject = asyncHandler(async (req, res) => {
  const project = await MangaProject.create({ ...req.body, owner: req.user._id });
  // Seed characters/description/cover from public manga metadata (Jikan).
  // Runs in the background — the create response doesn't wait on the network.
  if (req.body.fetchMetadata !== false) {
    void enrichFromPublicApi(project).catch((e) => logger.warn(`metadata enrich failed for ${project.title}: ${e.message}`));
  }
  ok(res, serializeProject(project, { chapters: 0, ready: 0, images: 0, stories: 0 }), 201);
});

/** Re-run the public metadata lookup (Jikan/MAL): upserts characters, fills description/tags/cover. */
export const fetchMetadata = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const result = await enrichFromPublicApi(project);
  ok(res, result);
});

export const getProjectDetails = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const stats = await projectStats([project._id as Types.ObjectId]);
  ok(res, serializeProject(project, stats.get(String(project._id)) || { chapters: 0, ready: 0, images: 0, stories: 0 }));
});

export const updateProject = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  project.set(req.body);
  await project.save();
  ok(res, serializeProject(project));
});

export const removeProject = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const active = await ProcessingJob.countDocuments({ project: project._id, status: { $in: ['queued', 'active', 'retrying'] } });
  if (active) throw new AppError('Cancel running jobs for this project before deleting it', 409);
  await deleteProject(project);
  ok(res, { id: String(project._id) }, 200, 'Project deleted');
});

export const uploadCover = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const file = uploadedFile(req, 'cover');
  if (!file) throw new AppError('cover image is required', 400);
  const dir = await makeTempDir('cover');
  try {
    const out = path.join(dir, 'cover.webp');
    await openSharp(file.path).rotate().resize({ width: 600, height: 900, fit: 'cover' }).webp({ quality: 85 }).toFile(out);
    const stored = await storeLocalFile(out, { folder: projectFolder(project._id as Types.ObjectId), originalName: 'cover.webp', owner: req.user._id });
    const old = project.cover;
    project.cover = stored._id as Types.ObjectId;
    await project.save();
    await deleteFileById(old);
    ok(res, serializeProject(project));
  } finally {
    await removeDir(dir);
  }
});

// ---------------------------------------------------------------- chapters
export const listChapters = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const chapters = await MangaChapter.find({ project: project._id }).sort({ order: 1 }).populate('archive', 'originalName size sha256');
  const jobs = await ProcessingJob.find({
    project: project._id,
    'target.kind': 'chapter',
    status: { $in: ['queued', 'active', 'retrying', 'failed'] },
  }).sort({ createdAt: -1 });
  const jobByChapter = new Map<string, ReturnType<typeof serializeJob>>();
  jobs.forEach((j) => {
    const key = String(j.target?.id);
    if (!jobByChapter.has(key)) jobByChapter.set(key, serializeJob(j));
  });
  ok(
    res,
    chapters.map((c) => {
      const archive = c.archive as any;
      return serializeChapter(c, {
        archive: archive?._id ? { id: String(archive._id), fileName: archive.originalName, size: archive.size } : undefined,
        job: jobByChapter.get(String(c._id)),
      });
    })
  );
});

export const updateChapter = asyncHandler(async (req, res) => {
  const chapter = await getChapter(req, req.params.chapterId);
  if (req.body.number !== undefined && req.body.number !== chapter.number) {
    const clash = await MangaChapter.exists({ project: chapter.project, number: req.body.number, _id: { $ne: chapter._id } });
    if (clash) throw new AppError(`Chapter ${req.body.number} already exists in this project`, 409);
  }
  chapter.set(req.body);
  await chapter.save();
  await emitChapter(chapter);
  ok(res, serializeChapter(chapter));
});

export const reorderChapters = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const ids: string[] = req.body.chapterIds;
  const count = await MangaChapter.countDocuments({ project: project._id, _id: { $in: ids } });
  if (count !== ids.length || new Set(ids).size !== ids.length) throw new AppError('chapterIds must list chapters of this project once', 400);
  await MangaChapter.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: id, project: project._id }, update: { $set: { order } } } })));
  ok(res, { chapterIds: ids }, 200, 'Chapters reordered');
});

/** Bulk renumber — validated as a whole so numbers can be swapped. */
export const renumberChapters = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const items: { id: string; number: number; title?: string }[] = req.body.items;
  const chapters = await MangaChapter.find({ project: project._id });
  const finalNumbers = new Map(chapters.map((c) => [String(c._id), c.number]));
  for (const item of items) {
    if (!finalNumbers.has(item.id)) throw new AppError(`Chapter ${item.id} is not in this project`, 400);
    finalNumbers.set(item.id, item.number);
  }
  const seen = new Map<number, string>();
  for (const [id, n] of finalNumbers) {
    if (seen.has(n)) throw new AppError(`Chapter number ${n} would be used twice`, 409);
    seen.set(n, id);
  }
  await MangaChapter.bulkWrite(
    items.map((i) => ({
      updateOne: { filter: { _id: i.id, project: project._id }, update: { $set: { number: i.number, ...(i.title ? { title: i.title } : {}) } } },
    }))
  );
  ok(res, { updated: items.length });
});

export const removeChapter = asyncHandler(async (req, res) => {
  const chapter = await getChapter(req, req.params.chapterId);
  const active = await ProcessingJob.countDocuments({ 'target.id': chapter._id, status: { $in: ['queued', 'active', 'retrying'] } });
  if (active) throw new AppError('This chapter has a running job — cancel it first', 409);
  await deleteChapter(chapter);
  ok(res, { id: String(chapter._id) }, 200, 'Chapter deleted');
});

export const reextractChapter = asyncHandler(async (req, res) => {
  const chapter = await getChapter(req, req.params.chapterId);
  if (!chapter.archive) throw new AppError('Chapter has no archive', 400);
  const job = await enqueueExtraction(chapter);
  ok(res, serializeJob(job), 202);
});

export const listChapterImages = asyncHandler(async (req, res) => {
  const chapter = await getChapter(req, req.params.chapterId);
  const images = await ComicImage.find({ chapter: chapter._id }).sort({ index: 1 });
  ok(res, images.map(serializeImage));
});

// ------------------------------------------------------------------ images
export const reextractImage = asyncHandler(async (req, res) => {
  const image = await getImage(req, req.params.imageId);
  const job = await enqueueJob({
    type: 'image-reextract',
    owner: image.owner,
    project: image.project,
    title: `Re-extract page ${image.index + 1}`,
    payload: { imageId: String(image._id) },
    target: { kind: 'image', id: image._id as Types.ObjectId },
    idempotencyKey: `reextract:${image._id}`,
  });
  ok(res, serializeJob(job), 202);
});

/** Replace a page with a user-provided image. The CBZ original is preserved. */
export const replaceImage = asyncHandler(async (req, res) => {
  const image = await getImage(req, req.params.imageId);
  const file = uploadedFile(req, 'image');
  if (!file) throw new AppError('image file is required', 400);
  const dir = await makeTempDir('replace');
  try {
    const thumbPath = path.join(dir, 'thumb.webp');
    const probe = await probeAndThumbnail(file.path, thumbPath);
    if (!probe.ok) throw new AppError(`Replacement image is unreadable: ${probe.error}`, 400);
    const folder = projectFolder(image.project, 'chapters', String(image.chapter), 'replacements');
    const stored = await storeLocalFile(file.path, { folder, originalName: file.originalname, mimetype: file.mimetype, owner: req.user._id });
    const thumb = await storeLocalFile(thumbPath, { folder, originalName: 'thumb.webp', owner: req.user._id });
    const oldFile = image.file;
    const oldThumb = image.thumbnail;
    if (oldFile && String(oldFile) !== String(image.originalFile)) await deleteFileById(oldFile);
    await deleteFileById(oldThumb);
    image.set({
      file: stored._id,
      thumbnail: thumb._id,
      width: probe.width,
      height: probe.height,
      format: probe.format,
      size: file.size,
      sha256: stored.checksum,
      isTall: isTallImage(probe.width, probe.height),
      status: 'replaced',
      error: undefined,
      panels: [],
      panelsDetectedAt: undefined,
    });
    await image.save();
    await refreshBrokenCount(image.chapter);
    ok(res, serializeImage(image));
  } finally {
    await removeDir(dir);
  }
});

/** Undo a replacement and go back to the page extracted from the CBZ. */
export const restoreImage = asyncHandler(async (req, res) => {
  const image = await getImage(req, req.params.imageId);
  if (!image.originalFile || String(image.file) === String(image.originalFile)) {
    throw new AppError('Image has no replacement to undo', 400);
  }
  const job = await enqueueJob({
    type: 'image-reextract',
    owner: image.owner,
    project: image.project,
    title: `Restore original page ${image.index + 1}`,
    payload: { imageId: String(image._id), restore: true },
    target: { kind: 'image', id: image._id as Types.ObjectId },
  });
  ok(res, serializeJob(job), 202);
});

export const refreshBrokenCount = async (chapterId: Types.ObjectId) => {
  const broken = await ComicImage.countDocuments({ chapter: chapterId, status: 'broken' });
  const chapter = await MangaChapter.findByIdAndUpdate(chapterId, { $set: { brokenImageCount: broken } }, { new: true });
  if (chapter) await emitChapter(chapter);
};

// ------------------------------------------------------------------ groups
export const listGroups = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const groups = await ChapterGroup.find({ project: project._id }).sort({ startNumber: 1 });
  ok(res, groups.map(serializeGroup));
});

export const createGroup = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const group = await ChapterGroup.create({
    owner: project.owner,
    project: project._id,
    name: req.body.name,
    startNumber: req.body.startNumber,
    endNumber: req.body.endNumber,
    chapters: req.body.chapterIds || [],
  });
  ok(res, serializeGroup(group), 201);
});

export const updateGroup = asyncHandler(async (req, res) => {
  const group = await ChapterGroup.findOne({ _id: assertObjectId(req.params.groupId), ...ownerFilter(req) });
  if (!group) throw notFound('Chapter group');
  group.set({ name: req.body.name, startNumber: req.body.startNumber, endNumber: req.body.endNumber, chapters: req.body.chapterIds || [] });
  await group.save();
  ok(res, serializeGroup(group));
});

export const removeGroup = asyncHandler(async (req, res) => {
  const group = await ChapterGroup.findOne({ _id: assertObjectId(req.params.groupId), ...ownerFilter(req) });
  if (!group) throw notFound('Chapter group');
  await group.deleteOne();
  ok(res, { id: String(group._id) });
});

// ----------------------------------------------------------------- uploads
export const startUpload = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const { session, resumed, warnings } = await createUploadSession(req, project, req.body);
  ok(res, { ...serializeUpload(session), resumed, warnings }, resumed ? 200 : 201);
});

export const listUploads = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.params.projectId);
  const sessions = await UploadSession.find({ project: project._id, owner: req.user._id, status: { $in: ['uploading', 'failed'] } }).sort({ createdAt: -1 });
  ok(res, sessions.map(serializeUpload));
});

export const getUpload = asyncHandler(async (req, res) => {
  ok(res, serializeUpload(await getUploadSession(req, req.params.uploadId)));
});

export const putChunk = asyncHandler(async (req: Request, res: Response) => {
  const session = await getUploadSession(req, req.params.uploadId);
  const updated = await writeChunk(req, session, Number(req.params.index));
  ok(res, { received: updated.received.length, totalChunks: updated.totalChunks });
});

export const finishUpload = asyncHandler(async (req, res) => {
  const { session, chapter, job } = await completeUpload(req, req.params.uploadId, req.body || {});
  ok(res, { upload: serializeUpload(session), chapter: serializeChapter(chapter), job: serializeJob(job) }, 201);
});

export const cancelUpload = asyncHandler(async (req, res) => {
  const session = await getUploadSession(req, req.params.uploadId);
  await abortUpload(session);
  ok(res, serializeUpload(session));
});

