import mongoose, { Document, Schema, Types } from 'mongoose';

export type AudioStatus = 'queued' | 'processing' | 'ready' | 'failed';

/** One rendered narration audio file, linked to its narration segment. */
export interface IGeneratedAudioDocument extends Document {
  owner: Types.ObjectId;
  project: Types.ObjectId;
  chapter?: Types.ObjectId;
  chapterNumber?: number;
  segment?: Types.ObjectId;
  /** free-standing clips (voice previews, manual lines) have no segment */
  purpose: 'narration' | 'preview' | 'reference';
  text: string;
  characters: number;
  words: number;
  language: string;
  provider: 'gemini' | 'local';
  modelId?: string;
  engine?: string;
  voiceId: string;
  voiceProfile?: Types.ObjectId;
  speed: number;
  file?: Types.ObjectId;
  status: AudioStatus;
  error?: string;
  duration?: number;
  waveform?: { peaks: number[]; duration: number; sampleRate: number };
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  job?: Types.ObjectId;
  version: number;
  history: { at: Date; voiceId: string; file?: Types.ObjectId; duration?: number }[];
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IGeneratedAudioDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject', required: true, index: true },
    chapter: { type: Schema.Types.ObjectId, ref: 'MangaChapter', index: true },
    chapterNumber: Number,
    segment: { type: Schema.Types.ObjectId, ref: 'StorySegment', index: true },
    purpose: { type: String, enum: ['narration', 'preview', 'reference'], default: 'narration', index: true },
    text: { type: String, required: true, maxlength: 20000 },
    characters: Number,
    words: Number,
    language: { type: String, default: 'hi', maxlength: 10 },
    provider: { type: String, enum: ['gemini', 'local'], required: true },
    modelId: String,
    engine: String,
    voiceId: { type: String, required: true, maxlength: 200 },
    voiceProfile: { type: Schema.Types.ObjectId, ref: 'VoiceProfile' },
    speed: { type: Number, default: 1, min: 0.5, max: 2 },
    file: { type: Schema.Types.ObjectId, ref: 'File' },
    status: { type: String, enum: ['queued', 'processing', 'ready', 'failed'], default: 'queued', index: true },
    error: String,
    duration: Number,
    waveform: { peaks: [Number], duration: Number, sampleRate: Number },
    inputTokens: Number,
    outputTokens: Number,
    costUSD: Number,
    job: { type: Schema.Types.ObjectId, ref: 'ProcessingJob' },
    version: { type: Number, default: 1 },
    history: [{ at: { type: Date, default: Date.now }, voiceId: String, file: { type: Schema.Types.ObjectId, ref: 'File' }, duration: Number }],
  },
  { timestamps: true }
);

schema.index({ project: 1, chapter: 1, status: 1 });
schema.index({ segment: 1, language: 1 });

export default mongoose.model<IGeneratedAudioDocument>('GeneratedAudio', schema);
