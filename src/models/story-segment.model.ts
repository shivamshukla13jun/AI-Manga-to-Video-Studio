import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IStorySnapshot {
  at: Date;
  source: 'ai' | 'user';
  note?: string;
  title?: string;
  narration: string;
}

/**
 * Narration for one or more consecutive scenes. Segments keep references
 * to their source scenes (and through them to the original panels).
 */
export interface IStorySegmentDocument extends Document {
  owner: Types.ObjectId;
  project: Types.ObjectId;
  chapter: Types.ObjectId;
  chapterNumber: number;
  scenes: Types.ObjectId[];
  order: number;
  language: string;
  mode: 'original' | 'recap';
  title?: string;
  narration: string;
  tone?: string;
  emotion?: string;
  wordCount: number;
  /** Seconds at the language's speaking rate (before TTS) */
  estimatedDuration: number;
  confidence?: number;
  /** Things the model flagged as unreadable / ambiguous */
  uncertainties: string[];
  userEdited: boolean;
  version: number;
  history: IStorySnapshot[];
  createdAt: Date;
  updatedAt: Date;
}

const segmentSchema = new Schema<IStorySegmentDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject', required: true },
    chapter: { type: Schema.Types.ObjectId, ref: 'MangaChapter', required: true },
    chapterNumber: { type: Number, required: true },
    scenes: [{ type: Schema.Types.ObjectId, ref: 'DetectedScene' }],
    order: { type: Number, required: true },
    language: { type: String, required: true },
    mode: { type: String, enum: ['original', 'recap'], default: 'original' },
    title: String,
    narration: { type: String, default: '' },
    tone: String,
    emotion: String,
    wordCount: { type: Number, default: 0 },
    estimatedDuration: { type: Number, default: 0 },
    confidence: { type: Number, min: 0, max: 1 },
    uncertainties: { type: [String], default: [] },
    userEdited: { type: Boolean, default: false },
    version: { type: Number, default: 1 },
    history: {
      type: [{ _id: false, at: Date, source: String, note: String, title: String, narration: String }],
      default: [],
    },
  },
  { timestamps: true, versionKey: false }
);

segmentSchema.index({ project: 1, language: 1, mode: 1, chapterNumber: 1, order: 1 });
segmentSchema.index({ chapter: 1, language: 1, mode: 1, order: 1 });
segmentSchema.index({ scenes: 1 });

const StorySegment = mongoose.model<IStorySegmentDocument>('StorySegment', segmentSchema);
export default StorySegment;
