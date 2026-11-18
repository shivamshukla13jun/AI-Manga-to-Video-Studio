import mongoose, { Document, Schema } from 'mongoose';

/**
 * One versioned price list for one provider/model. Prices are never
 * hardcoded in code: they are seeded from src/config/pricing/*.json
 * (copied from the provider's official pricing page, with source URL and
 * date) and can be updated from Settings. Multiple rows with different
 * effective windows model scheduled price changes.
 */
export interface IPricingConfigurationDocument extends Document {
  provider: string;
  modelId: string;
  kind: 'text' | 'vision' | 'tts';
  version: string;
  currency: 'USD';
  tier: 'standard' | 'batch';
  /** USD per 1M input tokens (text/image) */
  inputPerMillion: number;
  /** USD per 1M output tokens (text incl. thinking, or audio for TTS) */
  outputPerMillion: number;
  /** TTS: audio tokens generated per second of speech */
  audioTokensPerSecond?: number;
  effectiveFrom: Date;
  effectiveTo?: Date;
  sourceUrl: string;
  lastVerified: Date;
  notes?: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const pricingSchema = new Schema<IPricingConfigurationDocument>(
  {
    provider: { type: String, required: true },
    modelId: { type: String, required: true },
    kind: { type: String, enum: ['text', 'vision', 'tts'], required: true },
    version: { type: String, required: true },
    currency: { type: String, enum: ['USD'], default: 'USD' },
    tier: { type: String, enum: ['standard', 'batch'], default: 'standard' },
    inputPerMillion: { type: Number, required: true, min: 0 },
    outputPerMillion: { type: Number, required: true, min: 0 },
    audioTokensPerSecond: Number,
    effectiveFrom: { type: Date, required: true },
    effectiveTo: Date,
    sourceUrl: { type: String, required: true },
    lastVerified: { type: Date, required: true },
    notes: String,
    active: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false }
);

pricingSchema.index({ provider: 1, modelId: 1, tier: 1, effectiveFrom: 1, version: 1 }, { unique: true });

const PricingConfiguration = mongoose.model<IPricingConfigurationDocument>('PricingConfiguration', pricingSchema);
export default PricingConfiguration;
