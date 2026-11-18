import mongoose, { Document, Schema, Types } from 'mongoose';
import { bboxSchema, IBBox } from './comic-image.model';

/** One rectangular area of a source page that belongs to a scene. */
export interface ISceneRegion {
  image: Types.ObjectId;
  bbox: IBBox;
  order: number;
}

export interface IDialogue {
  speaker?: string;
  text: string;
  kind: 'speech' | 'thought' | 'narration' | 'sfx';
  /** OCR/translation could not be read with confidence — never guessed */
  uncertain: boolean;
}

export interface ISceneSnapshot {
  at: Date;
  source: 'ai' | 'cv' | 'user';
  note?: string;
  data: Record<string, unknown>;
}

export interface IDetectedSceneDocument extends Document {
  owner: Types.ObjectId;
  project: Types.ObjectId;
  chapter: Types.ObjectId;
  chapterNumber: number;
  /** Reading order within the chapter (fractional values allow insertion) */
  order: number;
  regions: ISceneRegion[];
  thumbnail?: Types.ObjectId;
  title?: string;
  characters: string[];
  location?: string;
  action?: string;
  emotion?: string;
  description?: string;
  events: string[];
  dialogues: IDialogue[];
  storyContext?: string;
  confidence?: number;
  source: 'ai' | 'cv' | 'user';
  /** Locks the scene against silent AI overwrites */
  userEdited: boolean;
  version: number;
  history: ISceneSnapshot[];
  createdAt: Date;
  updatedAt: Date;
}

const regionSchema = new Schema<ISceneRegion>(
  {
    image: { type: Schema.Types.ObjectId, ref: 'ComicImage', required: true },
    bbox: { type: bboxSchema, required: true },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

export const dialogueSchema = new Schema<IDialogue>(
  {
    speaker: String,
    text: { type: String, required: true },
    kind: { type: String, enum: ['speech', 'thought', 'narration', 'sfx'], default: 'speech' },
    uncertain: { type: Boolean, default: false },
  },
  { _id: false }
);

const sceneSchema = new Schema<IDetectedSceneDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject', required: true },
    chapter: { type: Schema.Types.ObjectId, ref: 'MangaChapter', required: true },
    chapterNumber: { type: Number, required: true },
    order: { type: Number, required: true },
    regions: { type: [regionSchema], default: [] },
    thumbnail: { type: Schema.Types.ObjectId, ref: 'File' },
    title: String,
    characters: { type: [String], default: [] },
    location: String,
    action: String,
    emotion: String,
    description: String,
    events: { type: [String], default: [] },
    dialogues: { type: [dialogueSchema], default: [] },
    storyContext: String,
    confidence: { type: Number, min: 0, max: 1 },
    source: { type: String, enum: ['ai', 'cv', 'user'], default: 'cv' },
    userEdited: { type: Boolean, default: false },
    version: { type: Number, default: 1 },
    history: {
      type: [{ _id: false, at: Date, source: String, note: String, data: Schema.Types.Mixed }],
      default: [],
    },
  },
  { timestamps: true, versionKey: false }
);

sceneSchema.index({ chapter: 1, order: 1 });
sceneSchema.index({ project: 1, chapterNumber: 1, order: 1 });
sceneSchema.index({ 'regions.image': 1 });

const DetectedScene = mongoose.model<IDetectedSceneDocument>('DetectedScene', sceneSchema);
export default DetectedScene;
