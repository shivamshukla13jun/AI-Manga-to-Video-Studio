import mongoose, { Document, Schema, Types } from 'mongoose';

/** Per-user studio preferences: budget guard, currency display, defaults. */
export interface IStudioSettingsDocument extends Document {
  owner: Types.ObjectId;
  /** Hard limit per generation request, in USD. 0 = no limit */
  budgetLimitUSD: number;
  /** Confirm any cloud generation estimated above this amount (USD) */
  confirmAboveUSD: number;
  displayCurrency: 'USD' | 'INR';
  usdToInr?: number;
  usdToInrUpdatedAt?: Date;
  usdToInrSource?: string;
  pricingTier: 'standard' | 'batch';
  defaultTtsProvider: 'local' | 'gemini';
  defaultVoiceProfile?: Types.ObjectId;
  /** Speaking-rate defaults (words per minute) used for duration estimates */
  /** AI engine for scene detection + story generation: cloud Gemini or local Python service */
  aiProvider: 'gemini' | 'local';
  /** Global narration language for ALL story generation (not per-project) */
  narrationLanguage: string;
  /** Global narration style for ALL story generation */
  narrationMode: 'original' | 'recap';
  wordsPerMinute: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

const settingsSchema = new Schema<IStudioSettingsDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    budgetLimitUSD: { type: Number, default: 5, min: 0 },
    confirmAboveUSD: { type: Number, default: 0, min: 0 },
    displayCurrency: { type: String, enum: ['USD', 'INR'], default: 'INR' },
    usdToInr: Number,
    usdToInrUpdatedAt: Date,
    usdToInrSource: String,
    pricingTier: { type: String, enum: ['standard', 'batch'], default: 'standard' },
    defaultTtsProvider: { type: String, enum: ['local', 'gemini'], default: 'local' },
    defaultVoiceProfile: { type: Schema.Types.ObjectId, ref: 'VoiceProfile' },
    aiProvider: { type: String, enum: ['gemini', 'local'], default: 'gemini' },
    narrationLanguage: { type: String, default: 'hi' },
    narrationMode: { type: String, enum: ['original', 'recap'], default: 'recap' },
    // conversational narration rates; editable per user after calibration
    wordsPerMinute: { type: Schema.Types.Mixed, default: () => ({ hi: 140, en: 150, default: 145 }) },
  },
  { timestamps: true, versionKey: false }
);

const StudioSettings = mongoose.model<IStudioSettingsDocument>('StudioSettings', settingsSchema);
export default StudioSettings;
