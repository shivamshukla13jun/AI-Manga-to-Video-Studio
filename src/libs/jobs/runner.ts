import { Job, UnrecoverableError, Worker } from 'bullmq';
import config from 'config/env';
import { bullMQService } from 'libs/bullmq/bullmq.service';
import ProcessingJob, { IProcessingJobDocument, JobType } from 'models/processing-job.model';
import { CANCEL_CHANNEL, emitToUser, subscribe } from 'libs/realtime/events';
import { JOB_QUEUE, broadcastJob } from './job.service';

/** Thrown when the user cancels a running job — never retried. */
export class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled by user');
  }
}

/** Errors that will fail the same way on retry (bad input, unsafe archive...). */
export class NonRetryableError extends Error {
  constructor(message: string, public code = 'NON_RETRYABLE') {
    super(message);
  }
}

export interface JobContext<P = Record<string, any>> {
  job: IProcessingJobDocument;
  payload: P;
  signal: AbortSignal;
  /** True when this is not the first execution (retry / resume) */
  isRerun: boolean;
  progress(percent: number, stage?: string): Promise<void>;
  log(message: string, level?: 'info' | 'warn' | 'error'): Promise<void>;
  throwIfCancelled(): void;
}

export type JobHandler<P = any> = (ctx: JobContext<P>) => Promise<Record<string, any> | void>;

const handlers = new Map<JobType, JobHandler>();
const running = new Map<string, AbortController>();

export const registerJobHandler = <P>(type: JobType, handler: JobHandler<P>) => {
  handlers.set(type, handler as JobHandler);
};

const PROGRESS_THROTTLE_MS = 750;

const runTracked = async (bullJob: Job<{ jobId: string }>) => {
  const job = await ProcessingJob.findById(bullJob.data.jobId);
  if (!job) throw new UnrecoverableError(`Tracked job ${bullJob.data.jobId} not found`);
  if (job.cancelRequested || job.status === 'cancelled') {
    if (job.status !== 'cancelled') {
      job.status = 'cancelled';
      job.completedAt = new Date();
      await job.save();
      await broadcastJob(job);
    }
    return;
  }
  const handler = handlers.get(job.type);
  if (!handler) throw new UnrecoverableError(`No handler registered for job type ${job.type}`);

  const controller = new AbortController();
  running.set(String(job._id), controller);

  job.status = 'active';
  job.attempts = bullJob.attemptsMade + 1;
  job.startedAt = job.startedAt || new Date();
  job.error = undefined;
  job.logs.push({ at: new Date(), level: 'info', message: `Started (attempt ${job.attempts}/${job.maxAttempts})` });
  await job.save();
  await broadcastJob(job);

  let lastFlush = 0;
  const ctx: JobContext = {
    job,
    payload: job.payload,
    signal: controller.signal,
    isRerun: job.runCount > 0 || bullJob.attemptsMade > 0,
    async progress(percent, stage) {
      const pct = Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
      const stageChanged = stage !== undefined && stage !== job.stage;
      job.progress = pct;
      if (stage !== undefined) job.stage = stage;
      const now = Date.now();
      if (!stageChanged && now - lastFlush < PROGRESS_THROTTLE_MS) return;
      lastFlush = now;
      await ProcessingJob.updateOne({ _id: job._id }, { $set: { progress: pct, stage: job.stage } });
      await bullJob.updateProgress(pct).catch(() => undefined);
      await broadcastJob(job);
    },
    async log(message, level = 'info') {
      const entry = { at: new Date(), level, message };
      job.logs.push(entry);
      await ProcessingJob.updateOne({ _id: job._id }, { $push: { logs: { $each: [entry], $slice: -500 } } });
      await emitToUser(job.owner, 'job:log', { job: String(job._id), ...entry }, job.project).catch(() => undefined);
    },
    throwIfCancelled() {
      if (controller.signal.aborted) throw new JobCancelledError();
    },
  };

  try {
    const result = await handler(ctx);
    ctx.throwIfCancelled();
    const done = await ProcessingJob.findByIdAndUpdate(
      job._id,
      {
        $set: { status: 'completed', progress: 100, result: result || job.result, completedAt: new Date() },
        $push: { logs: { $each: [{ at: new Date(), level: 'info', message: 'Completed' }], $slice: -500 } },
      },
      { new: true }
    );
    if (done) await broadcastJob(done);
  } catch (error: any) {
    const cancelled = error instanceof JobCancelledError || controller.signal.aborted;
    const permanent = cancelled || error instanceof NonRetryableError || error instanceof UnrecoverableError;
    const willRetry = !permanent && job.attempts < job.maxAttempts;
    const status = cancelled ? 'cancelled' : willRetry ? 'retrying' : 'failed';
    const message = cancelled ? 'Cancelled' : error?.message || String(error);
    const updated = await ProcessingJob.findByIdAndUpdate(
      job._id,
      {
        $set: {
          status,
          ...(cancelled ? {} : { error: { message, code: error?.code } }),
          ...(willRetry ? {} : { completedAt: new Date() }),
        },
        $push: {
          logs: {
            $each: [{ at: new Date(), level: cancelled ? 'warn' : 'error', message: willRetry ? `${message} — retrying` : message }],
            $slice: -500,
          },
        },
      },
      { new: true }
    );
    if (updated) await broadcastJob(updated);
    if (permanent) throw new UnrecoverableError(message);
    throw error;
  } finally {
    running.delete(String(job._id));
  }
};

const CONCURRENCY: Record<string, number> = {
  [JOB_QUEUE['cbz-extraction']]: config.JOB_CONCURRENCY_EXTRACTION,
  [JOB_QUEUE['pdf-conversion']]: config.JOB_CONCURRENCY_PDF,
  [JOB_QUEUE['image-processing']]: config.JOB_CONCURRENCY_IMAGE,
  [JOB_QUEUE['scene-detection']]: config.JOB_CONCURRENCY_AI,
  [JOB_QUEUE['story-generation']]: config.JOB_CONCURRENCY_AI,
  [JOB_QUEUE['tts-generation']]: config.JOB_CONCURRENCY_TTS,
  [JOB_QUEUE['video-rendering']]: config.JOB_CONCURRENCY_RENDER,
  [JOB_QUEUE.cleanup]: 1,
};

const workers: Worker[] = [];

/** Start one BullMQ worker per studio queue. Safe to call once per process. */
export const startStudioWorkers = async (): Promise<void> => {
  if (workers.length) return;
  await subscribe(CANCEL_CHANNEL, (jobId) => running.get(jobId)?.abort());

  const queues = [...new Set(Object.values(JOB_QUEUE))];
  for (const queueName of queues) {
    const worker = new Worker(queueName, runTracked, {
      connection: bullMQService.getConnection(),
      concurrency: CONCURRENCY[queueName] || 1,
      // long renders/extractions: renew locks well before they expire
      lockDuration: 120_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    });
    worker.on('error', (err) => console.error(`❌ [Studio worker] ${queueName}:`, err.message));
    workers.push(worker);
  }
  console.log(`👷 Studio workers started for ${queues.length} queues`);
};

export const stopStudioWorkers = async () => {
  running.forEach((c) => c.abort());
  await Promise.all(workers.map((w) => w.close()));
  workers.length = 0;
};
