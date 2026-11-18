import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * Resumable chunked upload. Chunks are written at their byte offset into a
 * temp file, so uploads can be paused, resumed after a refresh, or retried
 * chunk by chunk without re-sending what the server already has.
 */
export interface IUploadSessionDocument extends Document {
  owner: Types.ObjectId;
  project: Types.ObjectId;
  kind: 'cbz';
  fileName: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  received: number[];
  /** Optional client fingerprint (name+size+lastModified) to find a resumable session */
  fingerprint?: string;
  chapterNumber?: number;
  chapterTitle?: string;
  /** Replace the archive of an existing chapter instead of creating one */
  replaceChapter?: Types.ObjectId;
  /** Leading pages to drop during extraction (cover/credit pages) */
  skipPages?: number;
  autoMerge?: boolean;
  status: 'uploading' | 'completing' | 'completed' | 'failed' | 'aborted';
  error?: string;
  chapter?: Types.ObjectId;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<IUploadSessionDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject', required: true },
    kind: { type: String, enum: ['cbz'], default: 'cbz' },
    fileName: { type: String, required: true },
    size: { type: Number, required: true },
    chunkSize: { type: Number, required: true },
    totalChunks: { type: Number, required: true },
    received: { type: [Number], default: [] },
    fingerprint: String,
    chapterNumber: Number,
    chapterTitle: String,
    replaceChapter: { type: Schema.Types.ObjectId, ref: 'MangaChapter' },
    skipPages: Number,
    autoMerge: Boolean,
    status: {
      type: String,
      enum: ['uploading', 'completing', 'completed', 'failed', 'aborted'],
      default: 'uploading',
    },
    error: String,
    chapter: { type: Schema.Types.ObjectId, ref: 'MangaChapter' },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true, versionKey: false }
);

sessionSchema.index({ owner: 1, project: 1, fingerprint: 1, status: 1 });

const UploadSession = mongoose.model<IUploadSessionDocument>('UploadSession', sessionSchema);
export default UploadSession;
