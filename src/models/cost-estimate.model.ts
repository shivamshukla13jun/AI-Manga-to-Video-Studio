import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IEstimateItem {
  key: string;
  label: string;
  chapterNumber?: number;
  characters?: number;
  words?: number;
  durationSeconds?: number;
  requests?: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  meta?: Record<string, unknown>;
}

/**
 * A priced estimate shown to the user before an expensive generation.
 * Generation endpoints require a fresh, matching estimate (and enforce the
 * user's budget); actual usage is linked back via UsageRecord.estimate.
 */
export interface ICostEstimateDocument extends Document {
  owner: Types.ObjectId;
  project: Types.ObjectId;
  kind: 'scene-detection' | 'story-generation' | 'tts';
  provider: string;
  modelId: string;
  /** Hash of the request parameters; the job must use identical parameters */
  paramsHash: string;
  params: Record<string, unknown>;
  items: IEstimateItem[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    thoughtTokens: number;
    requests: number;
    characters?: number;
    words?: number;
    durationSeconds?: number;
    costUSD: number;
  };
  local?: { computeSeconds: number; storageBytes: number; engine: string };
  pricing?: { version: string; sourceUrl: string; lastVerified: Date; inputPerMillion: number; outputPerMillion: number; nextChange?: { effectiveFrom: Date; inputPerMillion: number; outputPerMillion: number } };
  currency: { usdToInr?: number; updatedAt?: Date; source?: string };
  tokenCountMethod: 'provider' | 'heuristic';
  assumptions: string[];
  budgetLimitUSD: number;
  withinBudget: boolean;
  approvedAt?: Date;
  job?: Types.ObjectId;
  expiresAt: Date;
  createdAt: Date;
}

const estimateSchema = new Schema<ICostEstimateDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject', required: true },
    kind: { type: String, enum: ['scene-detection', 'story-generation', 'tts'], required: true },
    provider: { type: String, required: true },
    modelId: { type: String, required: true },
    paramsHash: { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    items: { type: Schema.Types.Mixed as any, default: () => [] },
    totals: { type: Schema.Types.Mixed, required: true },
    local: Schema.Types.Mixed,
    pricing: Schema.Types.Mixed,
    currency: { type: Schema.Types.Mixed, default: {} },
    tokenCountMethod: { type: String, enum: ['provider', 'heuristic'], default: 'heuristic' },
    assumptions: { type: [String], default: [] },
    budgetLimitUSD: { type: Number, default: 0 },
    withinBudget: { type: Boolean, default: true },
    approvedAt: Date,
    job: { type: Schema.Types.ObjectId, ref: 'ProcessingJob' },
    // estimates are kept for the estimated-vs-actual comparison
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

estimateSchema.index({ owner: 1, createdAt: -1 });
estimateSchema.index({ project: 1, kind: 1, createdAt: -1 });

const CostEstimate = mongoose.model<ICostEstimateDocument>('CostEstimate', estimateSchema);
export default CostEstimate;
