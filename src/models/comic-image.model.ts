import mongoose, { Document, Schema, Types } from 'mongoose';

/** Normalized (0..1) rectangle relative to the source image */
export interface IBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const bboxSchema = new Schema<IBBox>(
  {
    x: { type: Number, required: true, min: 0, max: 1 },
    y: { type: Number, required: true, min: 0, max: 1 },
    width: { type: Number, required: true, min: 0, max: 1 },
    height: { type: Number, required: true, min: 0, max: 1 },
  },
  { _id: false }
);

export interface IPanel {
  _id: Types.ObjectId;
  bbox: IBBox;
  order: number;
  source: 'cv' | 'ai' | 'user';
  confidence?: number;
}

export interface IComicImageDocument extends Document {
  owner: Types.ObjectId;
  project: Types.ObjectId;
  chapter: Types.ObjectId;
  archive: Types.ObjectId;
  /** Reading order within the chapter (0-based) */
  index: number;
  /** Path of the entry inside the CBZ — used for re-extraction */
  entryName: string;
  /** Current file used by the studio (may be a user replacement) */
  file?: Types.ObjectId;
  /** The file originally extracted from the CBZ — never overwritten */
  originalFile?: Types.ObjectId;
  thumbnail?: Types.ObjectId;
  width: number;
  height: number;
  format?: string;
  size: number;
  sha256?: string;
  isTall: boolean;
  status: 'ok' | 'broken' | 'replaced';
  error?: string;
  panels: IPanel[];
  panelsDetectedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const panelSchema = new Schema<IPanel>({
  bbox: { type: bboxSchema, required: true },
  order: { type: Number, required: true },
  source: { type: String, enum: ['cv', 'ai', 'user'], default: 'cv' },
  confidence: Number,
});

const imageSchema = new Schema<IComicImageDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject', required: true },
    chapter: { type: Schema.Types.ObjectId, ref: 'MangaChapter', required: true },
    archive: { type: Schema.Types.ObjectId, ref: 'ComicArchive', required: true },
    index: { type: Number, required: true },
    entryName: { type: String, required: true },
    file: { type: Schema.Types.ObjectId, ref: 'File' },
    originalFile: { type: Schema.Types.ObjectId, ref: 'File' },
    thumbnail: { type: Schema.Types.ObjectId, ref: 'File' },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    format: String,
    size: { type: Number, default: 0 },
    sha256: String,
    isTall: { type: Boolean, default: false },
    status: { type: String, enum: ['ok', 'broken', 'replaced'], default: 'ok' },
    error: String,
    panels: { type: [panelSchema], default: [] },
    panelsDetectedAt: Date,
  },
  { timestamps: true, versionKey: false }
);

imageSchema.index({ chapter: 1, index: 1 });
imageSchema.index({ archive: 1, index: 1 });
imageSchema.index({ project: 1, status: 1 });

const ComicImage = mongoose.model<IComicImageDocument>('ComicImage', imageSchema);
export default ComicImage;
