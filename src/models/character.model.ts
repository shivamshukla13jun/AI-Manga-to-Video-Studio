import mongoose, { Document, Schema, Types } from 'mongoose';

/** Character registry used to keep names consistent across chapters. */
export interface ICharacterDocument extends Document {
  owner: Types.ObjectId;
  project: Types.ObjectId;
  name: string;
  aliases: string[];
  description?: string;
  appearance?: string;
  role?: string;
  firstChapter?: number;
  lastChapter?: number;
  /** Pronunciation hint passed to TTS (e.g. Devanagari spelling) */
  pronunciation?: string;
  /** Where this character was imported from (public metadata API) */
  external?: { provider: string; id: number; url?: string; imageUrl?: string };
  referenceImage?: { image: Types.ObjectId; bbox?: { x: number; y: number; width: number; height: number } };
  source: 'ai' | 'user' | 'api';
  createdAt: Date;
  updatedAt: Date;
}

const characterSchema = new Schema<ICharacterDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    aliases: { type: [String], default: [] },
    description: { type: String, maxlength: 2000 },
    appearance: { type: String, maxlength: 2000 },
    role: String,
    firstChapter: Number,
    lastChapter: Number,
    pronunciation: String,
    referenceImage: {
      image: { type: Schema.Types.ObjectId, ref: 'ComicImage' },
      bbox: { x: Number, y: Number, width: Number, height: Number },
    },
    external: { provider: String, id: Number, url: String, imageUrl: String },
    source: { type: String, enum: ['ai', 'user', 'api'], default: 'ai' },
  },
  { timestamps: true, versionKey: false }
);

characterSchema.index({ project: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

const Character = mongoose.model<ICharacterDocument>('Character', characterSchema);
export default Character;
