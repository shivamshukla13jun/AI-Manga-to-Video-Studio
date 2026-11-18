import path from 'path';
import { Types } from 'mongoose';
import MangaChapter from 'models/manga-chapter.model';
import ComicArchive from 'models/comic-archive.model';
import ComicImage, { IComicImageDocument } from 'models/comic-image.model';
import { registerJobHandler, NonRetryableError } from 'libs/jobs/runner';
import { openComicArchive, ArchiveError, ArchiveImageEntry } from 'libs/studio/archive';
import { deleteFileById, projectFolder, resolveLocal, storeLocalFile } from 'libs/studio/media';
import { makeTempDir, removeDir, sha256File, mimeForExt } from 'libs/studio/paths';
import { isTallImage, probeAndThumbnail } from 'libs/studio/images';
import { emitToUser } from 'libs/realtime/events';
import { serializeChapter, serializeImage } from 'microservices/manga-service/manga.serializers';

const pad = (n: number) => String(n + 1).padStart(4, '0');

/** Extract one archive entry, validate it and persist original + thumbnail. */
const extractEntry = async (
  archive: Awaited<ReturnType<typeof openComicArchive>>,
  item: ArchiveImageEntry,
  index: number,
  tempDir: string,
  folder: string,
  owner: Types.ObjectId
) => {
  const ext = path.extname(item.name).toLowerCase();
  const raw = path.join(tempDir, `${pad(index)}${ext}`);
  const thumbPath = path.join(tempDir, `${pad(index)}.thumb.webp`);
  await archive.extractTo(item, raw);
  const probe = await probeAndThumbnail(raw, thumbPath);
  const sha256 = await sha256File(raw);
  // Broken pages are still stored so they can be inspected / re-extracted / replaced —
  // a page is never silently dropped.
  const file = await storeLocalFile(raw, {
    folder: `${folder}/pages`,
    originalName: `${pad(index)}${ext}`,
    mimetype: mimeForExt(ext),
    owner,
    checksum: sha256,
  });
  const thumbnail = probe.ok
    ? await storeLocalFile(thumbPath, { folder: `${folder}/thumbs`, originalName: `${pad(index)}.webp`, owner })
    : undefined;
  return { probe, sha256, file, thumbnail, size: item.uncompressedSize };
};

registerJobHandler<{ chapterId: string }>('cbz-extraction', async (ctx) => {
  const chapter = await MangaChapter.findById(ctx.payload.chapterId);
  if (!chapter) throw new NonRetryableError('Chapter no longer exists');
  const archiveDoc = await ComicArchive.findById(chapter.archive);
  if (!archiveDoc) throw new NonRetryableError('Chapter archive not found');

  chapter.status = 'extracting';
  chapter.error = undefined;
  await chapter.save();
  await emitToUser(chapter.owner, 'chapter:update', serializeChapter(chapter), chapter.project);

  const tempDir = await makeTempDir('extract');
  try {
    await ctx.progress(1, 'Opening archive');
    const cbzPath = await resolveLocal(archiveDoc.file, tempDir);
    let archive;
    try {
      archive = await openComicArchive(cbzPath);
    } catch (error: any) {
      throw error instanceof ArchiveError ? new NonRetryableError(error.message, error.code) : error;
    }

    try {
      const { images, skipped } = archive.listing;
      if (!images.length) throw new NonRetryableError('Archive contains no supported images');
      if (skipped.length) await ctx.log(`Skipped ${skipped.length} non-image entries`, 'warn');
      archiveDoc.entryCount = archive.listing.entryCount;
      archiveDoc.imageCount = images.length;
      await archiveDoc.save();

      // Idempotent: pages already extracted from this archive are kept
      const existing = new Map<number, IComicImageDocument>();
      (await ComicImage.find({ archive: archiveDoc._id })).forEach((img) => existing.set(img.index, img));
      const folder = projectFolder(chapter.project, 'chapters', String(chapter._id));

      let broken = 0;
      for (let i = 0; i < images.length; i++) {
        ctx.throwIfCancelled();
        const item = images[i];
        const prev = existing.get(i);
        if (prev && prev.entryName === item.name && prev.file && prev.status !== 'broken') {
          await ctx.progress(5 + (90 * (i + 1)) / images.length, `Page ${i + 1}/${images.length} (cached)`);
          continue;
        }
        const r = await extractEntry(archive, item, i, tempDir, folder, chapter.owner);
        if (!r.probe.ok) {
          broken += 1;
          await ctx.log(`Page ${i + 1} (${item.name}) is broken: ${r.probe.error}`, 'warn');
        }
        if (prev) {
          if (String(prev.file) !== String(prev.originalFile)) await deleteFileById(prev.file);
          await deleteFileById(prev.originalFile);
          await deleteFileById(prev.thumbnail);
        }
        const doc = await ComicImage.findOneAndUpdate(
          { archive: archiveDoc._id, index: i },
          {
            $set: {
              owner: chapter.owner,
              project: chapter.project,
              chapter: chapter._id,
              entryName: item.name,
              file: r.file._id,
              originalFile: r.file._id,
              thumbnail: r.thumbnail?._id,
              width: r.probe.width,
              height: r.probe.height,
              format: r.probe.format,
              size: r.size,
              sha256: r.sha256,
              isTall: isTallImage(r.probe.width, r.probe.height),
              status: r.probe.ok ? 'ok' : 'broken',
              error: r.probe.error,
              panels: [],
            },
            $unset: { panelsDetectedAt: 1 },
          },
          { upsert: true, new: true }
        );
        await emitToUser(chapter.owner, 'image:update', serializeImage(doc!), chapter.project);
        await ctx.progress(5 + (90 * (i + 1)) / images.length, `Page ${i + 1}/${images.length}`);
      }

      // Pages from a replaced archive, or beyond the new page count, are removed
      const stale = await ComicImage.find({
        chapter: chapter._id,
        $or: [{ archive: { $ne: archiveDoc._id } }, { index: { $gte: images.length } }],
      });
      for (const img of stale) {
        if (String(img.file) !== String(img.originalFile)) await deleteFileById(img.file);
        await deleteFileById(img.originalFile);
        await deleteFileById(img.thumbnail);
        await img.deleteOne();
      }

      broken = await ComicImage.countDocuments({ chapter: chapter._id, status: 'broken' });
      chapter.status = 'ready';
      chapter.imageCount = images.length;
      chapter.brokenImageCount = broken;
      chapter.extractedAt = new Date();
      await chapter.save();
      await emitToUser(chapter.owner, 'chapter:update', serializeChapter(chapter), chapter.project);
      return { imageCount: images.length, brokenImages: broken };
    } finally {
      archive.close();
    }
  } catch (error: any) {
    chapter.status = 'failed';
    chapter.error = error?.message;
    await chapter.save();
    await emitToUser(chapter.owner, 'chapter:update', serializeChapter(chapter), chapter.project);
    throw error;
  } finally {
    await removeDir(tempDir);
  }
});

/** Re-extract a single page from the original CBZ (broken-image recovery / undo replacement). */
registerJobHandler<{ imageId: string; restore?: boolean }>('image-reextract', async (ctx) => {
  const image = await ComicImage.findById(ctx.payload.imageId);
  if (!image) throw new NonRetryableError('Image no longer exists');
  const archiveDoc = await ComicArchive.findById(image.archive);
  if (!archiveDoc) throw new NonRetryableError('Original archive not found');

  const tempDir = await makeTempDir('reextract');
  try {
    await ctx.progress(10, 'Opening original archive');
    const archive = await openComicArchive(await resolveLocal(archiveDoc.file, tempDir));
    try {
      const item = archive.listing.images.find((e) => e.name === image.entryName);
      if (!item) throw new NonRetryableError(`Entry ${image.entryName} not found in the original archive`);
      await ctx.progress(40, 'Extracting page');
      const folder = projectFolder(image.project, 'chapters', String(image.chapter));
      const r = await extractEntry(archive, item, image.index, tempDir, folder, image.owner);
      if (!r.probe.ok) {
        await deleteFileById(r.file._id);
        throw new NonRetryableError(`Page is corrupted inside the original CBZ: ${r.probe.error}. Replace it manually.`);
      }
      const replacement = image.file && String(image.file) !== String(image.originalFile) ? image.file : undefined;
      if (replacement) await deleteFileById(replacement);
      await deleteFileById(image.originalFile);
      await deleteFileById(image.thumbnail);
      image.set({
        file: r.file._id,
        originalFile: r.file._id,
        thumbnail: r.thumbnail?._id,
        width: r.probe.width,
        height: r.probe.height,
        format: r.probe.format,
        size: r.size,
        sha256: r.sha256,
        isTall: isTallImage(r.probe.width, r.probe.height),
        status: 'ok',
        error: undefined,
        panels: [],
        panelsDetectedAt: undefined,
      });
      await image.save();
      const broken = await ComicImage.countDocuments({ chapter: image.chapter, status: 'broken' });
      const chapter = await MangaChapter.findByIdAndUpdate(image.chapter, { $set: { brokenImageCount: broken } }, { new: true });
      await emitToUser(image.owner, 'image:update', serializeImage(image), image.project);
      if (chapter) await emitToUser(chapter.owner, 'chapter:update', serializeChapter(chapter), chapter.project);
      return { imageId: String(image._id) };
    } finally {
      archive.close();
    }
  } finally {
    await removeDir(tempDir);
  }
});
