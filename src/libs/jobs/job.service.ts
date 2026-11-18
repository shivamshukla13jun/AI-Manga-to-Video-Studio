import { Types } from 'mongoose';
import { bullMQService } from 'libs/bullmq/bullmq.service';
import { QUEUE_NAMES } from 'libs/bullmq/constants';
import ProcessingJob, { IProcessingJobDocument, JobType } from 'models/processing-job.model';
import { emitToUser, publishCancel } from 'libs/realtime/events';
import { AppError } from 'middlewares/error';

export const JOB_QUEUE: Record<JobType, string> = {
  'cbz-extraction': QUEUE_NAMES.CBZ_EXTRACTION,
  'image-reextract': QUEUE_NAMES.CBZ_EXTRACTION,
  'pdf-conversion': QUEUE_NAMES.PDF_CONVERSION,
  'image-processing': QUEUE_NAMES.IMAGE_PROCESSING,
  'scene-detection': QUEUE_NAMES.SCENE_DETECTION,
  'story-generation': QUEUE_NAMES.STORY_GENERATION,
  'tts-generation': QUEUE_NAMES.TTS_GENERATION,
  'video-rendering': QUEUE_NAMES.VIDEO_RENDERING,
  cleanup: QUEUE_NAMES.CLEANUP,
};

const DEFAULT_ATTEMPTS: Partial<Record<JobType, number>> = {
  'pdf-conversion': 2,
  'video-rendering': 2,
  'scene-detection': 3,
  'story-generation': 3,
  'tts-generation': 3,
};

type Id = Types.ObjectId | string;

export interface EnqueueOptions {
  type: JobType;
  owner: Id;
  project?: Id;
  title: string;
  payload?: Record<string, any>;
  target?: { kind: string; id: Id };
  idempotencyKey?: string;
  maxAttempts?: number;
}

export const serializeJob = (job: IProcessingJobDocument, withLogs = false) => ({
  id: String(job._id),
  type: job.type,
  title: job.title,
  status: job.status,
  progress: job.progress,
  stage: job.stage,
  project: job.project ? String(job.project) : undefined,
  target: job.target?.id ? { kind: job.target.kind, id: String(job.target.id) } : undefined,
  result: job.result,
  error: job.error?.message ? job.error : undefined,
  attempts: job.attempts,
  maxAttempts: job.maxAttempts,
  runCount: job.runCount,
  cancelRequested: job.cancelRequested,
  startedAt: job.startedAt,
  completedAt: job.completedAt,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  ...(withLogs ? { logs: job.logs } : {}),
});

export const broadcastJob = (job: IProcessingJobDocument) =>
  emitToUser(job.owner, 'job:update', serializeJob(job), job.project);

const addToQueue = async (job: IProcessingJobDocument) => {
  const queue = bullMQService.getQueue(JOB_QUEUE[job.type]);
  if (!queue) throw new AppError('Background job queue is unavailable (is Redis running?)', 503);
  await queue.add(
    job.type,
    { jobId: String(job._id) },
    {
      jobId: `${job._id}-${job.runCount}`,
      attempts: job.maxAttempts,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
};

/**
 * Create a tracked job and enqueue it. With an idempotency key, an
 * identical queued/active job is returned instead of creating a duplicate.
 */
export const enqueueJob = async (opts: EnqueueOptions): Promise<IProcessingJobDocument> => {
  if (opts.idempotencyKey) {
    const existing = await ProcessingJob.findOne({
      idempotencyKey: opts.idempotencyKey,
      status: { $in: ['queued', 'active', 'retrying'] },
    });
    if (existing) return existing;
  }
  const job = await ProcessingJob.create({
    type: opts.type,
    owner: opts.owner,
    project: opts.project,
    title: opts.title,
    payload: opts.payload || {},
    target: opts.target,
    idempotencyKey: opts.idempotencyKey,
    maxAttempts: opts.maxAttempts ?? DEFAULT_ATTEMPTS[opts.type] ?? 3,
    logs: [{ at: new Date(), level: 'info', message: 'Job queued' }],
  });
  try {
    await addToQueue(job);
  } catch (error: any) {
    job.status = 'failed';
    job.error = { message: error.message || 'Failed to enqueue job' };
    await job.save();
    throw error;
  }
  await broadcastJob(job);
  return job;
};

export const cancelJob = async (job: IProcessingJobDocument) => {
  if (['completed', 'failed', 'cancelled'].includes(job.status)) {
    throw new AppError(`Job is already ${job.status}`, 409);
  }
  job.cancelRequested = true;
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.completedAt = new Date();
    await bullMQService
      .getQueue(JOB_QUEUE[job.type])
      ?.remove(`${job._id}-${job.runCount}`)
      .catch(() => undefined);
  }
  job.logs.push({ at: new Date(), level: 'warn', message: 'Cancellation requested' });
  await job.save();
  await publishCancel(String(job._id));
  await broadcastJob(job);
  return job;
};

/** Re-run a failed/cancelled job. Processors skip work that already completed. */
export const retryJob = async (job: IProcessingJobDocument) => {
  if (!['failed', 'cancelled'].includes(job.status)) {
    throw new AppError('Only failed or cancelled jobs can be retried', 409);
  }
  job.status = 'queued';
  job.progress = 0;
  job.error = undefined;
  job.cancelRequested = false;
  job.attempts = 0;
  job.runCount += 1;
  job.completedAt = undefined;
  job.logs.push({ at: new Date(), level: 'info', message: `Retry #${job.runCount} queued` });
  await job.save();
  await addToQueue(job);
  await broadcastJob(job);
  return job;
};

/** Latest job per target, e.g. to show chapter extraction state. */
export const latestJobFor = (targetId: Id, type?: JobType) =>
  ProcessingJob.findOne({ 'target.id': targetId, ...(type ? { type } : {}) }).sort({ createdAt: -1 });
