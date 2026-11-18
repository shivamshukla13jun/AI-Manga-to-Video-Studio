import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import MangaChapter from 'models/manga-chapter.model';
import ComicImage, { IComicImageDocument } from 'models/comic-image.model';
import PdfExport from 'models/pdf-export.model';
import { registerJobHandler, NonRetryableError, JobCancelledError } from 'libs/jobs/runner';
import { projectFolder, resolveLocal, storeLocalFile } from 'libs/studio/media';
import { makeTempDir, removeDir } from 'libs/studio/paths';
import { openSharp } from 'libs/studio/images';
import { emitToUser } from 'libs/realtime/events';

/** PDF viewers (Acrobat) cap page dimensions at 14400pt (200 inches). */
const MAX_PAGE_PT = 14400;
/** CSS pixel → PDF point, so pages open at the image's natural size. */
const PX_TO_PT = 0.75;
const NUMBER_STRIP_PT = 22;

type Compression = 'none' | 'balanced' | 'small';

/**
 * Prepare an image buffer for embedding:
 * - none: JPEG and PNG are embedded as-is (JPEG is passed through without
 *   recompression); WebP/GIF are converted losslessly to PNG.
 * - balanced / small: re-encode to JPEG with a width cap to reduce size.
 */
const prepareImage = async (buf: Buffer, compression: Compression) => {
  const meta = await openSharp(buf).metadata();
  if (!meta.width || !meta.height) throw new Error('Image has no dimensions');
  if (compression === 'none') {
    if (meta.format === 'jpeg' || meta.format === 'png') {
      // honour EXIF orientation only when present (otherwise keep original bytes)
      if (meta.orientation && meta.orientation > 1) {
        const rotated = await openSharp(buf).rotate().toBuffer({ resolveWithObject: true });
        return { data: rotated.data, width: rotated.info.width, height: rotated.info.height };
      }
      return { data: buf, width: meta.width, height: meta.height };
    }
    const png = await openSharp(buf).rotate().png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true });
    return { data: png.data, width: png.info.width, height: png.info.height };
  }
  const maxWidth = compression === 'small' ? 1200 : 2000;
  const quality = compression === 'small' ? 70 : 86;
  const out = await openSharp(buf)
    .rotate()
    .resize({ width: maxWidth, withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data: out.data, width: out.info.width, height: out.info.height };
};

registerJobHandler<{ exportId: string }>('pdf-conversion', async (ctx) => {
  const exp = await PdfExport.findById(ctx.payload.exportId);
  if (!exp) throw new NonRetryableError('PDF export no longer exists');
  const chapters = await MangaChapter.find({ _id: { $in: exp.chapters } });
  const byId = new Map(chapters.map((c) => [String(c._id), c]));
  const ordered = exp.chapters.map((id) => byId.get(String(id))).filter(Boolean) as typeof chapters;
  if (!ordered.length) throw new NonRetryableError('None of the selected chapters exist anymore');

  exp.status = 'processing';
  exp.error = undefined;
  await exp.save();
  const notify = () => emitToUser(exp.owner, 'pdf:update', { id: String(exp._id), status: exp.status }, exp.project);
  await notify();

  const tempDir = await makeTempDir('pdf');
  const outPath = path.join(tempDir, 'output.pdf');
  try {
    // Pages come from the extracted ComicImage rows (skipped/deleted pages and
    // manual replacements are reflected) — the CBZ itself is not kept on disk.
    // A chapter may still be extracting; wait for it before giving up.
    await ctx.progress(1, 'Reading pages');
    const sources: { chapter: (typeof ordered)[number]; images: IComicImageDocument[] }[] = [];
    let totalPages = 0;
    for (const chapter of ordered) {
      const deadline = Date.now() + 5 * 60 * 1000;
      while (['uploaded', 'extracting'].includes(chapter.status)) {
        ctx.throwIfCancelled();
        if (Date.now() > deadline) throw new NonRetryableError(`Chapter ${chapter.number} extraction did not finish in time`);
        await ctx.progress(1, `Waiting for chapter ${chapter.number} extraction`);
        await new Promise((r) => setTimeout(r, 2000));
        chapter.status = (await MangaChapter.findById(chapter._id).select('status'))?.status ?? chapter.status;
      }
      if (chapter.status !== 'ready') throw new NonRetryableError(`Chapter ${chapter.number} extraction failed — fix it before exporting`);
      const images = await ComicImage.find({ chapter: chapter._id }).sort({ index: 1 });
      if (!images.length) throw new NonRetryableError(`Chapter ${chapter.number} has no extracted pages`);
      totalPages += images.length;
      sources.push({ chapter, images });
    }

    const doc = new PDFDocument({
      autoFirstPage: false,
      compress: true,
      info: { Title: exp.fileName.replace(/\.pdf$/i, ''), Creator: 'AI Manga-to-Video Studio' },
    });
    const out = fs.createWriteStream(outPath);
    const finished = new Promise<void>((resolve, reject) => {
      out.on('finish', () => resolve());
      out.on('error', reject);
      doc.on('error', reject);
    });
    doc.pipe(out);

    let pageNo = 0;
    for (const { chapter, images } of sources) {
      let first = true;
      for (const img of images) {
        if (ctx.signal.aborted) throw new JobCancelledError();
        pageNo += 1;
        const pageName = img.entryName || `page ${img.index + 1}`;
        let prepared: Awaited<ReturnType<typeof prepareImage>> | null = null;
        try {
          if (!img.file) throw new Error('page file is missing');
          const buf = await fs.promises.readFile(await resolveLocal(img.file, tempDir));
          prepared = await prepareImage(buf, exp.options.compression);
        } catch (error: any) {
          await ctx.log(`Chapter ${chapter.number} page ${pageName}: ${error.message} — placeholder page inserted`, 'warn');
        }

        const width = prepared?.width ?? 800;
        const height = prepared?.height ?? 1100;
        const scale = Math.min(PX_TO_PT, (MAX_PAGE_PT - NUMBER_STRIP_PT) / height);
        const pw = width * scale;
        const ph = height * scale;
        const strip = exp.options.pageNumbers ? NUMBER_STRIP_PT : 0;
        doc.addPage({ size: [pw, ph + strip], margin: 0 });
        if (prepared) {
          doc.image(prepared.data, 0, 0, { width: pw, height: ph });
        } else {
          doc.rect(0, 0, pw, ph).fill('#f1f3f5');
          doc.fillColor('#495057').fontSize(16).text(`Page could not be decoded\n${pageName}`, 20, ph / 2 - 20, {
            width: pw - 40,
            align: 'center',
          });
        }
        if (strip) {
          doc.fillColor('#555555').fontSize(10).text(String(pageNo), 0, ph + 6, { width: pw, align: 'center', lineBreak: false });
        }
        if (first && exp.options.bookmarks) {
          doc.outline.addItem(`Chapter ${chapter.number} — ${chapter.title}`);
          first = false;
        }
        await ctx.progress(2 + (93 * pageNo) / totalPages, `Chapter ${chapter.number}: page ${pageNo}/${totalPages}`);
      }
    }

    doc.end();
    await finished;
    await ctx.progress(97, 'Saving PDF');
    const stored = await storeLocalFile(outPath, {
      folder: projectFolder(exp.project, 'exports'),
      originalName: exp.fileName,
      mimetype: 'application/pdf',
      owner: exp.owner,
    });
    exp.status = 'completed';
    exp.file = stored._id as any;
    exp.pageCount = pageNo;
    exp.size = stored.size;
    await exp.save();
    await notify();
    return { exportId: String(exp._id), pageCount: pageNo, size: stored.size };
  } catch (error: any) {
    exp.status = error instanceof JobCancelledError || ctx.signal.aborted ? 'cancelled' : 'failed';
    exp.error = error.message;
    await exp.save();
    await notify();
    throw error;
  } finally {
    await removeDir(tempDir);
  }
});
