import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * A selectable voice: a provider prebuilt voice or a user-created custom
 * voice (voice replication). Custom voices keep the reference + consent
 * audio on record — replication is only attempted with explicit consent.
 */
export interface IVoiceProfileDocument extends Document {
  owner: Types.ObjectId;
  name: string;
  provider: 'gemini' | 'local';
  kind: 'prebuilt' | 'custom';
  /** provider-side voice identifier (prebuilt voice name, cloned voice ref, or local model id) */
  voiceId: string;
  engine?: string;
  language: string;
  languages: string[];
  gender?: string;
  description?: string;
  styleHint?: string;
  referenceAudio?: Types.ObjectId;
  consentAudio?: Types.ObjectId;
  consentConfirmed: boolean;
  consentNote?: string;
  status: 'ready' | 'pending' | 'failed';
  statusError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IVoiceProfileDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    provider: { type: String, enum: ['gemini', 'local'], required: true, index: true },
    kind: { type: String, enum: ['prebuilt', 'custom'], required: true },
    voiceId: { type: String, required: true, maxlength: 200 },
    engine: String,
    language: { type: String, default: 'en', maxlength: 10 },
    languages: { type: [String], default: [] },
    gender: String,
    description: { type: String, maxlength: 1000 },
    styleHint: { type: String, maxlength: 500 },
    referenceAudio: { type: Schema.Types.ObjectId, ref: 'File' },
    consentAudio: { type: Schema.Types.ObjectId, ref: 'File' },
    consentConfirmed: { type: Boolean, default: false },
    consentNote: { type: String, maxlength: 500 },
    status: { type: String, enum: ['ready', 'pending', 'failed'], default: 'ready' },
    statusError: String,
  },
  { timestamps: true }
);

schema.index({ owner: 1, provider: 1, kind: 1 });

export default mongoose.model<IVoiceProfileDocument>('VoiceProfile', schema);
