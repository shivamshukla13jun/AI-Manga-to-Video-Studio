import { Router } from 'express';
import { Middleware } from 'middlewares';
import ProcessingJob, { JOB_STATUSES, JOB_TYPES } from 'models/processing-job.model';
import { asyncHandler, assertObjectId, notFound, ok, ownerFilter, parseIntQuery } from 'libs/studio/http';
import { cancelJob, retryJob, serializeJob } from 'libs/jobs/job.service';

const router = Router();
router.use(Middleware.verifyToken);

const loadJob = async (req: any) => {
  const job = await ProcessingJob.findOne({ _id: assertObjectId(req.params.jobId, 'job id'), ...ownerFilter(req) });
  if (!job) throw notFound('Job');
  return job;
};

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { ...ownerFilter(req) };
    if (req.query.project) filter.project = assertObjectId(req.query.project, 'project id');
    if (req.query.target) filter['target.id'] = assertObjectId(req.query.target, 'target id');
    const statuses = String(req.query.status || '').split(',').filter((s) => (JOB_STATUSES as readonly string[]).includes(s));
    if (statuses.length) filter.status = { $in: statuses };
    const types = String(req.query.type || '').split(',').filter((t) => (JOB_TYPES as readonly string[]).includes(t));
    if (types.length) filter.type = { $in: types };
    const jobs = await ProcessingJob.find(filter).sort({ createdAt: -1 }).limit(parseIntQuery(req.query.limit, 50, 500));
    ok(res, jobs.map((j) => serializeJob(j)));
  })
);

router.get('/:jobId', asyncHandler(async (req, res) => ok(res, serializeJob(await loadJob(req), true))));
router.post('/:jobId/cancel', asyncHandler(async (req, res) => ok(res, serializeJob(await cancelJob(await loadJob(req))))));
router.post('/:jobId/retry', asyncHandler(async (req, res) => ok(res, serializeJob(await retryJob(await loadJob(req))))));

export default router;
