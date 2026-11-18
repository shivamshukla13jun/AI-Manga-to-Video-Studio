import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IPdfExportDocument extends Document {
  owner: Types.ObjectId;
  project: Types.ObjectId;
  fileName: string;
  /** Chapters in the exact order they will be merged */
  chapters: Types.ObjectId[];
  options: {
    pageNumbers: boolean;
    bookmarks: boolean;
    compression: 'none' | 'balanced' | 'small';
  };
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  job?: Types.ObjectId;
  file?: Types.ObjectId;
  pageCount?: number;
  size?: number;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const pdfSchema = new Schema<IPdfExportDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject', required: true, index: true },
    fileName: { type: String, required: true },
    chapters: [{ type: Schema.Types.ObjectId, ref: 'MangaChapter' }],
    options: {
      pageNumbers: { type: Boolean, default: false },
      bookmarks: { type: Boolean, default: true },
      compression: { type: String, enum: ['none', 'balanced', 'small'], default: 'none' },
    },
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed', 'cancelled'],
      default: 'queued',
    },
    job: { type: Schema.Types.ObjectId, ref: 'ProcessingJob' },
    file: { type: Schema.Types.ObjectId, ref: 'File' },
    pageCount: Number,
    size: Number,
    error: String,
  },
  { timestamps: true, versionKey: false }
);

const PdfExport = mongoose.model<IPdfExportDocument>('PdfExport', pdfSchema);
export default PdfExport;
