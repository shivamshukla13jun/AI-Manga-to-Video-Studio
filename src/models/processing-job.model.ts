import mongoose, { Document, Schema, Types } from 'mongoose';

export const JOB_TYPES = [
  'cbz-extraction',
  'image-reextract',
  'pdf-conversion',
  'image-processing',
  'scene-detection',
  'story-generation',
  'tts-generation',
  'video-rendering',
  'cleanup',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['queued', 'active', 'retrying', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface IJobLog {
  at: Date;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface IProcessingJobDocument extends Document {
  owner: Types.ObjectId;
  project?: Types.ObjectId;
  type: JobType;
  title: string;
  status: JobStatus;
  progress: number;
  stage?: string;
  /** Domain object this job works on, e.g. { kind: 'chapter', id } */
  target?: { kind: string; id: Types.ObjectId };
  payload: Record<string, any>;
  result?: Record<string, any>;
  error?: { message: string; code?: string; details?: any };
  attempts: number;
  maxAttempts: number;
  runCount: number;
  cancelRequested: boolean;
  /** Deduplicates identical in-flight jobs (idempotent enqueue) */
  idempotencyKey?: string;
  logs: IJobLog[];
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const jobSchema = new Schema<IProcessingJobDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject' },
    type: { type: String, enum: JOB_TYPES, required: true },
    title: { type: String, required: true },
    status: { type: String, enum: JOB_STATUSES, default: 'queued' },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    stage: String,
    target: {
      kind: String,
      id: { type: Schema.Types.ObjectId },
    },
    payload: { type: Schema.Types.Mixed, default: {} },
    result: Schema.Types.Mixed,
    error: {
      message: String,
      code: String,
      details: Schema.Types.Mixed,
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    runCount: { type: Number, default: 0 },
    cancelRequested: { type: Boolean, default: false },
    idempotencyKey: String,
    logs: {
      type: [
        {
          _id: false,
          at: { type: Date, default: Date.now },
          level: { type: String, enum: ['info', 'warn', 'error'], default: 'info' },
          message: String,
        },
      ],
      default: [],
    },
    startedAt: Date,
    completedAt: Date,
  },
  { timestamps: true, versionKey: false }
);

jobSchema.index({ owner: 1, createdAt: -1 });
jobSchema.index({ project: 1, status: 1 });
jobSchema.index({ status: 1, type: 1 });
jobSchema.index({ 'target.id': 1, type: 1 });
jobSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: 'string' },
      status: { $in: ['queued', 'active', 'retrying'] },
    },
  }
);

const ProcessingJob = mongoose.model<IProcessingJobDocument>('ProcessingJob', jobSchema);
export default ProcessingJob;
