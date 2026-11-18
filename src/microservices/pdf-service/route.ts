import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import config from 'config/env';
import { Middleware } from 'middlewares';
import { AppError } from 'middlewares/error';
import PdfExport, { IPdfExportDocument } from 'models/pdf-export.model';
import { asyncHandler, assertObjectId, notFound, ok, ownerFilter } from 'libs/studio/http';
import { enqueueJob, serializeJob } from 'libs/jobs/job.service';
import { deleteFileById, signMediaPath } from 'libs/studio/media';
import { sanitizeFilename } from 'libs/studio/paths';
import ProcessingJob from 'models/processing-job.model';
import { getProject, resolveChapterSelection } from 'microservices/manga-service/manga.service';

const router = Router();
router.use(Middleware.verifyToken);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const createSchema = z
  .object({
    projectId: objectId,
    chapterIds: z.array(objectId).max(2000).optional(),
    startNumber: z.coerce.number().min(0).optional(),
    endNumber: z.coerce.number().min(0).optional(),
    fileName: z.string().max(200).optional(),
    pageNumbers: z.boolean().default(false),
    bookmarks: z.boolean().default(true),
    compression: z.enum(['none', 'balanced', 'small']).default('none'),
  })
  .refine((b) => b.chapterIds?.length || (b.startNumber !== undefined && b.endNumber !== undefined), {
    message: 'Select chapters or a start/end chapter range',
  });

const formatRange = (numbers: number[]) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => i === 0 || n - sorted[i - 1] === 1);
  if (sorted.length === 1) return `Chapter ${sorted[0]}`;
  return contiguous ? `Chapters ${sorted[0]}-${sorted[sorted.length - 1]}` : `Chapters ${sorted.join(', ')}`.slice(0, 120);
};

const serialize = (e: IPdfExportDocument, job?: any) => ({
  id: String(e._id),
  project: String(e.project),
  fileName: e.fileName,
  chapters: e.chapters.map(String),
  options: e.options,
  status: e.status,
  pageCount: e.pageCount,
  size: e.size,
  error: e.error,
  job: job ? serializeJob(job) : e.job ? String(e.job) : undefined,
  downloadUrl: e.file ? `${config.BASE_URL}${signMediaPath(e.file)}&download=1&name=${encodeURIComponent(e.fileName)}` : null,
  previewUrl: e.file ? `${config.BASE_URL}${signMediaPath(e.file)}` : null,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
});

/** Merge a chapter range (or an explicit, ordered selection) into one PDF. No AI involved. */
router.post(
  '/exports',
  Middleware.requestValidate(createSchema),
  asyncHandler(async (req, res) => {
    const project = await getProject(req, req.body.projectId);
    const chapters = await resolveChapterSelection(project._id as Types.ObjectId, req.body);
    if (!chapters.length) throw new AppError('No chapters found in the selected range', 400);
    const missing = chapters.filter((c) => !c.archive);
    if (missing.length) throw new AppError(`Chapters without a CBZ: ${missing.map((c) => c.number).join(', ')}`, 400);

    const fileName = sanitizeFilename(
      req.body.fileName?.trim() ? req.body.fileName.replace(/\.pdf$/i, '') : `${project.title} - ${formatRange(chapters.map((c) => c.number))}`,
      'comic'
    ) + '.pdf';
    const exp = await PdfExport.create({
      owner: project.owner,
      project: project._id,
      fileName,
      chapters: chapters.map((c) => c._id),
      options: { pageNumbers: req.body.pageNumbers, bookmarks: req.body.bookmarks, compression: req.body.compression },
    });
    const job = await enqueueJob({
      type: 'pdf-conversion',
      owner: project.owner,
      project: project._id as Types.ObjectId,
      title: `PDF — ${fileName}`,
      payload: { exportId: String(exp._id) },
      target: { kind: 'pdf-export', id: exp._id as Types.ObjectId },
    });
    exp.job = job._id as Types.ObjectId;
    await exp.save();
    ok(res, serialize(exp, job), 202);
  })
);

router.get(
  '/exports',
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { ...ownerFilter(req) };
    if (req.query.project) filter.project = assertObjectId(req.query.project, 'project id');
    const pdfExports = await PdfExport.find(filter).sort({ createdAt: -1 }).limit(100);
    const jobs = await ProcessingJob.find({ _id: { $in: pdfExports.map((e) => e.job).filter(Boolean) } });
    const jobById = new Map(jobs.map((j) => [String(j._id), j]));
    ok(res, pdfExports.map((e) => serialize(e, e.job ? jobById.get(String(e.job)) : undefined)));
  })
);

const loadExport = async (req: any) => {
  const exp = await PdfExport.findOne({ _id: assertObjectId(req.params.exportId), ...ownerFilter(req) });
  if (!exp) throw notFound('PDF export');
  return exp;
};

router.get('/exports/:exportId', asyncHandler(async (req, res) => ok(res, serialize(await loadExport(req)))));

router.delete(
  '/exports/:exportId',
  asyncHandler(async (req, res) => {
    const exp = await loadExport(req);
    if (['queued', 'processing'].includes(exp.status)) throw new AppError('Cancel the conversion before deleting it', 409);
    await deleteFileById(exp.file);
    await exp.deleteOne();
    ok(res, { id: String(exp._id) });
  })
);

export default router;
