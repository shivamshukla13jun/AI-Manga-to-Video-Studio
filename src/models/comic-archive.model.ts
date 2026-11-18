import mongoose, { Document, Schema, Types } from 'mongoose';

/** The original uploaded CBZ — preserved untouched for re-extraction. */
export interface IComicArchiveDocument extends Document {
  owner: Types.ObjectId;
  project: Types.ObjectId;
  chapter?: Types.ObjectId;
  file: Types.ObjectId;
  originalName: string;
  size: number;
  sha256: string;
  entryCount: number;
  imageCount: number;
  /** Suggested metadata read from ComicInfo.xml when present */
  comicInfo?: { title?: string; number?: string; series?: string };
  /** Superseded by a replacement upload (kept until the chapter is deleted) */
  replaced: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const archiveSchema = new Schema<IComicArchiveDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject', required: true },
    chapter: { type: Schema.Types.ObjectId, ref: 'MangaChapter' },
    file: { type: Schema.Types.ObjectId, ref: 'File', required: true },
    originalName: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    entryCount: { type: Number, default: 0 },
    imageCount: { type: Number, default: 0 },
    comicInfo: { title: String, number: String, series: String },
    replaced: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false }
);

archiveSchema.index({ project: 1, sha256: 1 });
archiveSchema.index({ chapter: 1 });

const ComicArchive = mongoose.model<IComicArchiveDocument>('ComicArchive', archiveSchema);
export default ComicArchive;
