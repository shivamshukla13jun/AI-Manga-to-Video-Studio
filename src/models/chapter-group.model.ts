import mongoose, { Document, Schema, Types } from 'mongoose';

/** Named chapter range, e.g. "The Beginning — Chapters 1 to 5" */
export interface IChapterGroupDocument extends Document {
  owner: Types.ObjectId;
  project: Types.ObjectId;
  name: string;
  startNumber: number;
  endNumber: number;
  /** Explicit selection; when empty, all chapters in [start, end] are used */
  chapters: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const groupSchema = new Schema<IChapterGroupDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    startNumber: { type: Number, required: true },
    endNumber: { type: Number, required: true },
    chapters: [{ type: Schema.Types.ObjectId, ref: 'MangaChapter' }],
  },
  { timestamps: true, versionKey: false }
);

const ChapterGroup = mongoose.model<IChapterGroupDocument>('ChapterGroup', groupSchema);
export default ChapterGroup;
