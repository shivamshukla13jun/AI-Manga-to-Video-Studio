import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { Request } from 'express';
import { Types } from 'mongoose';
import config from 'config/env';
import { AppError } from 'middlewares/error';
import MangaProject, { IMangaProjectDocument } from 'models/manga-project.model';
import MangaChapter, { IMangaChapterDocument } from 'models/manga-chapter.model';
import ComicArchive from 'models/comic-archive.model';
import ComicImage from 'models/comic-image.model';
import ChapterGroup from 'models/chapter-group.model';
import UploadSession, { IUploadSessionDocument } from 'models/upload-session.model';
import PdfExport from 'models/pdf-export.model';
import { enqueueJob } from 'libs/jobs/job.service';
import { emitToUser } from 'libs/realtime/events';
import { deleteFileById, projectFolder, storeLocalFile } from 'libs/studio/media';
import { guessChapterNumber, looksLikeZip, openComicArchive, ArchiveError } from 'libs/studio/archive';
import { safeJoin, sanitizeFilename, sha256File, tempRoot } from 'libs/studio/paths';
import { assertObjectId, notFound, ownerFilter } from 'libs/studio/http';
import { serializeChapter } from './manga.serializers';

// ---------------------------------------------------------------------------
// Ownership-checked lookups
// ---------------------------------------------------------------------------
export const getProject = async (req: Request, id: unknown): Promise<IMangaProjectDocument> => {
  const project = await MangaProject.findOne({ _id: assertObjectId(id, 'project id'), ...ownerFilter(req) });
  if (!project) throw notFound('Project');
  return project;
};

export const getChapter = async (req: Request, id: unknown): Promise<IMangaChapterDocument> => {
  const chapter = await MangaChapter.findOne({ _id: assertObjectId(id, 'chapter id'), ...ownerFilter(req) });
  if (!chapter) throw notFound('Chapter');
  return chapter;
};

export const getImage = async (req: Request, id: unknown) => {
  const image = await ComicImage.findOne({ _id: assertObjectId(id, 'image id'), ...ownerFilter(req) });
  if (!image) throw notFound('Image');
  return image;
};

export const emitChapter = (chapter: IMangaChapterDocument) =>
  emitToUser(chapter.owner, 'chapter:update', serializeChapter(chapter), chapter.project);

export const nextChapterOrder = async (projectId: Types.ObjectId) => {
  const last = await MangaChapter.findOne({ project: projectId }).sort({ order: -1 }).select('order');
  return (last?.order ?? -1) + 1;
};

export const enqueueExtraction = (chapter: IMangaChapterDocument) =>
  enqueueJob({
    type: 'cbz-extraction',
    owner: chapter.owner,
    project: chapter.project,
    title: `Extract images — ${chapter.title}`,
    payload: { chapterId: String(chapter._id) },
    target: { kind: 'chapter', id: chapter._id as Types.ObjectId },
    idempotencyKey: `extract:${chapter._id}:${chapter.archive}`,
  });

// ---------------------------------------------------------------------------
// Resumable chunked CBZ upload
// ---------------------------------------------------------------------------
const uploadDir = () => path.join(tempRoot(), 'uploads');
const partPath = (session: IUploadSessionDocument) => safeJoin(uploadDir(), `${session._id}.part`);

export interface CreateUploadInput {
  fileName: string;
  size: number;
  fingerprint?: string;
  chapterNumber?: number;
  chapterTitle?: string;
  replaceChapterId?: string;
  skipPages?: number;
  autoMerge?: boolean;
}

export const createUploadSession = async (
  req: Request,
  project: IMangaProjectDocument,
  input: CreateUploadInput
) => {
  const fileName = sanitizeFilename(input.fileName, 'chapter.cbz');
  if (!/\.(cbz|zip)$/i.test(fileName)) throw new AppError('Only .cbz (or .zip) archives are accepted', 400);
  if (input.size <= 0 || input.size > config.CBZ_MAX_FILE_SIZE) {
    throw new AppError(`File size must be between 1 byte and ${config.CBZ_MAX_FILE_SIZE} bytes`, 413);
  }

  let replaceChapter: IMangaChapterDocument | undefined;
  if (input.replaceChapterId) {
    replaceChapter = await getChapter(req, input.replaceChapterId);
    if (String(replaceChapter.project) !== String(project._id)) throw new AppError('Chapter belongs to another project', 400);
  }

  // Resume an unfinished session for the same file (survives page refresh)
  if (input.fingerprint) {
    const existing = await UploadSession.findOne({
      owner: req.user._id,
      project: project._id,
      fingerprint: input.fingerprint,
      size: input.size,
      status: 'uploading',
      expiresAt: { $gt: new Date() },
    });
    if (existing && fs.existsSync(partPath(existing))) {
      if (input.chapterNumber !== undefined) existing.chapterNumber = input.chapterNumber;
      if (input.chapterTitle !== undefined) existing.chapterTitle = input.chapterTitle;
      if (input.skipPages !== undefined) existing.skipPages = input.skipPages;
      if (input.autoMerge !== undefined) existing.autoMerge = input.autoMerge;
      await existing.save();
      return { session: existing, resumed: true, warnings: [] as string[] };
    }
  }

  const chunkSize = config.UPLOAD_CHUNK_SIZE;
  const session = await UploadSession.create({
    owner: req.user._id,
    project: project._id,
    fileName,
    size: input.size,
    chunkSize,
    totalChunks: Math.ceil(input.size / chunkSize),
    fingerprint: input.fingerprint,
    chapterNumber: input.chapterNumber,
    chapterTitle: input.chapterTitle?.trim() || undefined,
    replaceChapter: replaceChapter?._id,
    skipPages: input.skipPages || undefined,
    autoMerge: input.autoMerge || undefined,
    expiresAt: new Date(Date.now() + config.UPLOAD_SESSION_TTL_HOURS * 3600_000),
  });
  await fs.promises.mkdir(uploadDir(), { recursive: true });
  // pre-create the sparse target file so chunks can be written at any offset
  await (await fs.promises.open(partPath(session), 'w')).close();

  const warnings: string[] = [];
  const number = input.chapterNumber ?? guessChapterNumber(fileName);
  if (!replaceChapter && number !== undefined && (await MangaChapter.exists({ project: project._id, number }))) {
    warnings.push(`Chapter ${number} already exists in this project`);
  }
  return { session, resumed: false, warnings };
};

export const getUploadSession = async (req: Request, id: unknown) => {
  const session = await UploadSession.findOne({ _id: assertObjectId(id, 'upload id'), owner: req.user._id });
  if (!session) throw notFound('Upload session');
  return session;
};

/** Stream one chunk from the request body straight to its offset on disk. */
export const writeChunk = async (req: Request, session: IUploadSessionDocument, index: number) => {
  if (session.status !== 'uploading') throw new AppError(`Upload is ${session.status}`, 409);
  if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
    throw new AppError('Invalid chunk index', 400);
  }
  const start = index * session.chunkSize;
  const expected = Math.min(session.chunkSize, session.size - start);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared !== expected) {
    throw new AppError(`Chunk ${index} must be exactly ${expected} bytes`, 400);
  }

  let received = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > expected) cb(new AppError('Chunk is larger than expected', 413));
      else cb(null, chunk);
    },
  });
  await pipeline(req, guard, fs.createWriteStream(partPath(session), { flags: 'r+', start }));
  if (received !== expected) throw new AppError(`Chunk ${index} incomplete (${received}/${expected} bytes)`, 400);

  const updated = await UploadSession.findByIdAndUpdate(
    session._id,
    { $addToSet: { received: index } },
    { new: true }
  );
  return updated!;
};

export class DuplicateArchiveError extends AppError {}

/**
 * Verify the assembled CBZ, check for duplicates, validate the archive,
 * store the original through the storage provider and queue extraction.
 */
export const completeUpload = async (
  req: Request,
  sessionId: unknown,
  opts: { allowDuplicate?: boolean }
) => {
  const session = await UploadSession.findOneAndUpdate(
    { _id: assertObjectId(sessionId, 'upload id'), owner: req.user._id, status: 'uploading' },
    { $set: { status: 'completing' } },
    { new: true }
  );
  if (!session) throw new AppError('Upload session not found or already completed', 409);

  const filePath = partPath(session);
  const fail = async (message: string, status = 400, keepResumable = false) => {
    session.status = keepResumable ? 'uploading' : 'failed';
    session.error = message;
    await session.save();
    if (!keepResumable) await fs.promises.unlink(filePath).catch(() => undefined);
    throw new AppError(message, status);
  };

  const missing = Array.from({ length: session.totalChunks }, (_, i) => i).filter((i) => !session.received.includes(i));
  if (missing.length) return fail(`Missing ${missing.length} chunk(s): ${missing.slice(0, 10).join(', ')}`, 409, true);

  const { size } = await fs.promises.stat(filePath);
  if (size !== session.size) return fail(`Size mismatch (${size} vs ${session.size})`);
  if (!(await looksLikeZip(filePath))) return fail('File is not a valid CBZ/ZIP archive');

  const sha256 = await sha256File(filePath);
  const project = await MangaProject.findById(session.project);
  if (!project) return fail('Project no longer exists', 404);

  const duplicate = await ComicArchive.findOne({ project: project._id, sha256, replaced: false });
  if (duplicate && !opts.allowDuplicate) {
    const dupChapter = duplicate.chapter ? await MangaChapter.findById(duplicate.chapter).select('number title') : null;
    session.status = 'uploading'; // let the user confirm and complete again
    session.error = 'duplicate';
    await session.save();
    throw new AppError(
      `This archive is identical to ${dupChapter ? `Chapter ${dupChapter.number} — ${dupChapter.title}` : duplicate.originalName}`,
      409,
      { duplicate: { chapterId: duplicate.chapter && String(duplicate.chapter), fileName: duplicate.originalName } }
    );
  }

  // Validate structure + safety limits before accepting the file
  let imageCount = 0;
  let entryCount = 0;
  let comicInfo: Record<string, string | undefined> | undefined;
  try {
    const archive = await openComicArchive(filePath);
    imageCount = archive.listing.images.length;
    entryCount = archive.listing.entryCount;
    comicInfo = archive.listing.comicInfo;
    archive.close();
  } catch (error: any) {
    return fail(error instanceof ArchiveError ? error.message : `Unreadable archive: ${error.message}`);
  }
  if (!imageCount) return fail('Archive contains no JPG, PNG or WebP images');
  const skipPages = Math.max(0, Math.floor(session.skipPages || 0));
  if (skipPages >= imageCount) return fail(`Skipping the first ${skipPages} page(s) leaves no pages to extract`);

  const stored = await storeLocalFile(filePath, {
    folder: projectFolder(project._id, 'archives'),
    originalName: session.fileName,
    mimetype: 'application/vnd.comicbook+zip',
    owner: req.user._id,
    checksum: sha256,
  });

  let chapter: IMangaChapterDocument;
  try {
    const archive = await ComicArchive.create({
      owner: project.owner,
      project: project._id,
      file: stored._id,
      originalName: session.fileName,
      size,
      sha256,
      entryCount,
      imageCount,
      comicInfo,
    });

    if (session.replaceChapter) {
      const existing = await MangaChapter.findById(session.replaceChapter);
      if (!existing) throw notFound('Chapter to replace');
      const old = await ComicArchive.find({ chapter: existing._id, _id: { $ne: archive._id } });
      for (const a of old) {
        const f = a.file;
        a.file = undefined;
        a.replaced = true;
        await a.save();
        await deleteFileById(f);
      }
      existing.archive = archive._id as Types.ObjectId;
      existing.skipPages = skipPages;
      existing.autoMerge = !!session.autoMerge;
      existing.status = 'uploaded';
      existing.error = undefined;
      chapter = await existing.save();
    } else {
      const number =
        session.chapterNumber ??
        (comicInfo?.number && Number.isFinite(Number(comicInfo.number)) ? Number(comicInfo.number) : undefined) ??
        guessChapterNumber(session.fileName) ??
        (await MangaChapter.countDocuments({ project: project._id })) + 1;
      chapter = await MangaChapter.create({
        owner: project.owner,
        project: project._id,
        number,
        title: session.chapterTitle || comicInfo?.title || `Chapter ${number}`,
        order: await nextChapterOrder(project._id as Types.ObjectId),
        archive: archive._id,
        skipPages,
        kind: session.autoMerge ? 'merged' : 'chapter',
        autoMerge: !!session.autoMerge,
        status: 'uploaded',
        imageCount,
      });
    }
    archive.chapter = chapter._id as Types.ObjectId;
    await archive.save();
  } catch (error) {
    await deleteFileById(stored._id);
    session.status = 'failed';
    session.error = (error as Error).message;
    await session.save();
    throw error;
  }

  session.status = 'completed';
  session.error = undefined;
  session.chapter = chapter._id as Types.ObjectId;
  await session.save();
  await fs.promises.unlink(filePath).catch(() => undefined);

  const job = await enqueueExtraction(chapter);
  await emitChapter(chapter);
  return { session, chapter, job };
};

export const abortUpload = async (session: IUploadSessionDocument) => {
  if (['completed'].includes(session.status)) throw new AppError('Upload already completed', 409);
  session.status = 'aborted';
  await session.save();
  await fs.promises.unlink(partPath(session)).catch(() => undefined);
};

// ---------------------------------------------------------------------------
// Deletion — removes derived media and original archives of the chapter
// ---------------------------------------------------------------------------
export const deleteChapterMedia = async (chapterId: Types.ObjectId | string, borrowed = false) => {
  // Merged units built from other chapters only borrow file refs — never delete
  // them. An uploaded merged unit owns its files and deletes them normally.
  if (!borrowed) {
    const images = await ComicImage.find({ chapter: chapterId }).select('file originalFile thumbnail');
    for (const img of images) {
      await deleteFileById(img.thumbnail);
      if (img.file && String(img.file) !== String(img.originalFile)) await deleteFileById(img.file);
      await deleteFileById(img.originalFile);
    }
  }
  await ComicImage.deleteMany({ chapter: chapterId });
  const archives = await ComicArchive.find({ chapter: chapterId });
  for (const a of archives) await deleteFileById(a.file);
  await ComicArchive.deleteMany({ chapter: chapterId });
};

export const deleteChapter = async (chapter: IMangaChapterDocument) => {
  const merged = chapter.kind === 'merged';
  const borrowed = merged && (chapter.sourceChapters?.length ?? 0) > 0;
  if (merged && chapter.pdfExport) {
    const exp = await PdfExport.findById(chapter.pdfExport);
    if (exp) {
      if (['queued', 'processing'].includes(exp.status)) throw new AppError('This unit has a running PDF conversion — cancel it first', 409);
      await deleteFileById(exp.file);
      await exp.deleteOne();
    }
  }
  await deleteChapterMedia(chapter._id as Types.ObjectId, borrowed);
  await ChapterGroup.updateMany({ project: chapter.project }, { $pull: { chapters: chapter._id } });
  await chapter.deleteOne();
  // Deleting a source chapter removes the underlying page files — drop merged units built on it.
  if (!merged) {
    const dependents = await MangaChapter.find({ project: chapter.project, kind: 'merged', sourceChapters: chapter._id });
    for (const m of dependents) await deleteChapter(m);
  }
};

export const deleteProject = async (project: IMangaProjectDocument) => {
  const chapters = await MangaChapter.find({ project: project._id });
  for (const c of chapters) await deleteChapterMedia(c._id as Types.ObjectId, c.kind === 'merged' && (c.sourceChapters?.length ?? 0) > 0);
  await MangaChapter.deleteMany({ project: project._id });
  await ChapterGroup.deleteMany({ project: project._id });
  const pdfExports = await PdfExport.find({ project: project._id });
  for (const e of pdfExports) await deleteFileById(e.file);
  await PdfExport.deleteMany({ project: project._id });
  await UploadSession.deleteMany({ project: project._id });
  await deleteFileById(project.cover);
  await project.deleteOne();
};

/** Chapters selected by explicit ids (in the given order) or by number range. */
export const resolveChapterSelection = async (
  projectId: Types.ObjectId | string,
  sel: { chapterIds?: string[]; startNumber?: number; endNumber?: number }
): Promise<IMangaChapterDocument[]> => {
  if (sel.chapterIds?.length) {
    const docs = await MangaChapter.find({ project: projectId, _id: { $in: sel.chapterIds } });
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const ordered = sel.chapterIds.map((id) => byId.get(id)).filter(Boolean) as IMangaChapterDocument[];
    if (ordered.length !== sel.chapterIds.length) throw new AppError('Some selected chapters were not found', 400);
    return ordered;
  }
  if (sel.startNumber === undefined || sel.endNumber === undefined) {
    throw new AppError('Provide chapterIds or startNumber/endNumber', 400);
  }
  if (sel.endNumber < sel.startNumber) throw new AppError('End chapter must be ≥ start chapter', 400);
  return MangaChapter.find({ project: projectId, number: { $gte: sel.startNumber, $lte: sel.endNumber } }).sort({
    number: 1,
    order: 1,
  });
};

// ---------------------------------------------------------------------------
// Merge chapters into ≤50MB PDF "special chapter" units
// Each unit is a MangaChapter{kind:'merged'} whose ComicImage rows share the
// source pages' file refs (no duplication) + a queued PdfExport job.
// ---------------------------------------------------------------------------
const MERGE_LIMIT_MB = 50;

export const mergeChaptersToPdfUnits = async (
  project: IMangaProjectDocument,
  opts: { chapterIds?: string[]; maxSizeMB?: number }
) => {
  const limitBytes = Math.min(Math.max(opts.maxSizeMB || MERGE_LIMIT_MB, 1), 50) * 1024 * 1024;
  const selection = opts.chapterIds?.length
    ? await resolveChapterSelection(project._id as Types.ObjectId, { chapterIds: opts.chapterIds })
    : await MangaChapter.find({ project: project._id, kind: { $ne: 'merged' }, status: 'ready', archive: { $ne: null } }).sort({ order: 1 });
  const chapters = selection.filter((c) => c.kind !== 'merged' && c.archive);
  if (!chapters.length) throw new AppError('No ready chapters with an archive to merge', 400);

  const bytes = await ComicImage.aggregate<{ _id: Types.ObjectId; bytes: number; pages: number }>([
    { $match: { chapter: { $in: chapters.map((c) => c._id) } } },
    { $group: { _id: '$chapter', bytes: { $sum: '$size' }, pages: { $sum: 1 } } },
  ]);
  const sizeOf = new Map(bytes.map((b) => [String(b._id), b]));

  const batches: IMangaChapterDocument[][] = [];
  let current: IMangaChapterDocument[] = [];
  let currentBytes = 0;
  for (const c of chapters) {
    const b = sizeOf.get(String(c._id))?.bytes ?? 0;
    if (current.length && currentBytes + b > limitBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(c);
    currentBytes += b;
  }
  if (current.length) batches.push(current);
  if (batches.length > 1 && batches.some((b) => b.reduce((s, c) => s + (sizeOf.get(String(c._id))?.bytes ?? 0), 0) > limitBytes)) {
    const oversized = batches
      .filter((b) => b.reduce((s, c) => s + (sizeOf.get(String(c._id))?.bytes ?? 0), 0) > limitBytes)
      .flatMap((b) => b.map((c) => c.number));
    throw new AppError(`Chapters exceed ${opts.maxSizeMB || MERGE_LIMIT_MB}MB each and can't be merged: ${oversized.join(', ')}`, 400);
  }

  const lastOrder = (await MangaChapter.findOne({ project: project._id }).sort({ order: -1 }).select('order'))?.order ?? 0;
  const created: { chapter: IMangaChapterDocument; exportDoc: any; job: any }[] = [];
  for (const [bi, batch] of batches.entries()) {
    const nums = batch.map((c) => c.number).sort((a, b) => a - b);
    const title = nums.length === 1 ? `Chapter ${nums[0]} — merged` : `Chapters ${nums[0]}–${nums[nums.length - 1]} — merged`;
    const merged = await MangaChapter.create({
      owner: project.owner,
      project: project._id,
      number: Math.max(...nums) + 0.5,
      title,
      order: lastOrder + bi + 1,
      kind: 'merged',
      sourceChapters: batch.map((c) => c._id),
      status: 'ready',
      extractedAt: new Date(),
    });
    const images = await ComicImage.find({ chapter: { $in: batch.map((c) => c._id) } }).sort({ chapter: 1, index: 1 });
    const cloned = await ComicImage.insertMany(
      images.map((img, i) => ({
        owner: img.owner,
        project: img.project,
        chapter: merged._id,
        archive: img.archive,
        index: i,
        entryName: img.entryName,
        file: img.file,
        originalFile: img.originalFile,
        thumbnail: img.thumbnail,
        width: img.width,
        height: img.height,
        format: img.format,
        size: img.size,
        sha256: img.sha256,
        isTall: img.isTall,
        status: img.status,
        panels: [],
      }))
    );
    merged.imageCount = cloned.length;

    const fileName =
      sanitizeFilename(`${project.title} - Chapters ${nums.join('-')}`, 'comic') + '.pdf';
    const exportDoc = await PdfExport.create({
      owner: project.owner,
      project: project._id,
      fileName,
      chapters: [merged._id],
      options: { pageNumbers: false, bookmarks: true, compression: 'none' },
    });
    const job = await enqueueJob({
      type: 'pdf-conversion',
      owner: project.owner,
      project: project._id as Types.ObjectId,
      title: `PDF — ${fileName}`,
      payload: { exportId: String(exportDoc._id) },
      target: { kind: 'pdf-export', id: exportDoc._id as Types.ObjectId },
    });
    exportDoc.job = job._id as Types.ObjectId;
    await exportDoc.save();
    merged.pdfExport = exportDoc._id as Types.ObjectId;
    await merged.save();
    await emitChapter(merged);
    created.push({ chapter: merged, exportDoc, job });
  }
  return created;
};
