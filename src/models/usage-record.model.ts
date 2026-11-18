import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * Actual provider usage as reported by the API (not an estimate), priced
 * with the pricing configuration that was active at the time of the call.
 */
export interface IUsageRecordDocument extends Document {
  owner: Types.ObjectId;
  project?: Types.ObjectId;
  job?: Types.ObjectId;
  provider: string;
  modelId: string;
  kind: 'vision' | 'text' | 'tts' | 'voice';
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  audioSeconds?: number;
  costUSD: number;
  pricingVersion?: string;
  /** Optional link to the estimate this call was approved under */
  estimate?: Types.ObjectId;
  createdAt: Date;
}

const usageSchema = new Schema<IUsageRecordDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject' },
    job: { type: Schema.Types.ObjectId, ref: 'ProcessingJob' },
    provider: { type: String, required: true },
    modelId: { type: String, required: true },
    kind: { type: String, enum: ['vision', 'text', 'tts', 'voice'], required: true },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    thoughtTokens: { type: Number, default: 0 },
    audioSeconds: Number,
    costUSD: { type: Number, default: 0 },
    pricingVersion: String,
    estimate: { type: Schema.Types.ObjectId, ref: 'CostEstimate' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

usageSchema.index({ owner: 1, createdAt: -1 });
usageSchema.index({ project: 1, kind: 1 });
usageSchema.index({ estimate: 1 });

const UsageRecord = mongoose.model<IUsageRecordDocument>('UsageRecord', usageSchema);
export default UsageRecord;
