import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IMangaProjectDocument extends Document {
  owner: Types.ObjectId;
  title: string;
  description?: string;
  /** Source language of the comic (BCP-47, e.g. "ko", "ja", "en") */
  language: string;
  /** Default narration language (BCP-47, Hindi by default) */
  narrationLanguage: string;
  narrationMode: 'original' | 'recap';
  cover?: Types.ObjectId;
  status: 'active' | 'archived';
  tags: string[];
  /** Rolling story summary passed to later chapter analysis for continuity */
  continuitySummary?: string;
  /** Last chapter number the continuity summary covers */
  continuityThrough?: number;
  /** Public metadata API hit used to seed characters/description */
  metadata?: { provider: string; externalId: number; title?: string; url?: string; fetchedAt?: Date };
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<IMangaProjectDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, maxlength: 5000 },
    language: { type: String, default: 'en' },
    narrationLanguage: { type: String, default: 'hi' },
    narrationMode: { type: String, enum: ['original', 'recap'], default: 'original' },
    cover: { type: Schema.Types.ObjectId, ref: 'File' },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    tags: { type: [String], default: [] },
    continuitySummary: String,
    continuityThrough: Number,
    metadata: { provider: String, externalId: Number, title: String, url: String, fetchedAt: Date },
  },
  { timestamps: true, versionKey: false }
);

projectSchema.index({ owner: 1, updatedAt: -1 });

const MangaProject = mongoose.model<IMangaProjectDocument>('MangaProject', projectSchema);
export default MangaProject;
