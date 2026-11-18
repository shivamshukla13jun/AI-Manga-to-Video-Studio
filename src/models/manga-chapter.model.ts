import mongoose, { Document, Schema, Types } from 'mongoose';

export const CHAPTER_STATUSES = ['uploaded', 'extracting', 'ready', 'failed'] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

export interface IMangaChapterDocument extends Document {
  owner: Types.ObjectId;
  project: Types.ObjectId;
  /** User-assigned chapter number (decimals allowed, e.g. 10.5) */
  number: number;
  title: string;
  /** Display / reading order inside the project */
  order: number;
  archive?: Types.ObjectId;
  /** 'merged' = synthetic chapter produced by merging several source chapters into one PDF unit */
  kind: 'chapter' | 'merged';
  sourceChapters: Types.ObjectId[];
  /** The merged PDF export this unit was built from */
  pdfExport?: Types.ObjectId;
  /** Leading archive pages skipped during extraction (cover/credit pages) */
  skipPages: number;
  autoMerge: boolean;
  status: ChapterStatus;
  imageCount: number;
  brokenImageCount: number;
  error?: string;
  extractedAt?: Date;
  analysisStatus: 'none' | 'processing' | 'done' | 'failed';
  storyStatus: 'none' | 'processing' | 'done' | 'failed';
  /** Short summary of this chapter's events, produced by story generation */
  summary?: string;
  createdAt: Date;
  updatedAt: Date;
}

const chapterSchema = new Schema<IMangaChapterDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject', required: true },
    number: { type: Number, required: true, min: 0 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    order: { type: Number, required: true },
    archive: { type: Schema.Types.ObjectId, ref: 'ComicArchive' },
    kind: { type: String, enum: ['chapter', 'merged'], default: 'chapter' },
    sourceChapters: [{ type: Schema.Types.ObjectId, ref: 'MangaChapter' }],
    pdfExport: { type: Schema.Types.ObjectId, ref: 'PdfExport' },
    skipPages: { type: Number, default: 0, min: 0 },
    autoMerge: { type: Boolean, default: false },
    status: { type: String, enum: CHAPTER_STATUSES, default: 'uploaded' },
    imageCount: { type: Number, default: 0 },
    brokenImageCount: { type: Number, default: 0 },
    error: String,
    extractedAt: Date,
    analysisStatus: { type: String, enum: ['none', 'processing', 'done', 'failed'], default: 'none' },
    storyStatus: { type: String, enum: ['none', 'processing', 'done', 'failed'], default: 'none' },
    summary: String,
  },
  { timestamps: true, versionKey: false }
);

chapterSchema.index({ project: 1, order: 1 });
chapterSchema.index({ project: 1, number: 1 });

const MangaChapter = mongoose.model<IMangaChapterDocument>('MangaChapter', chapterSchema);
export default MangaChapter;
