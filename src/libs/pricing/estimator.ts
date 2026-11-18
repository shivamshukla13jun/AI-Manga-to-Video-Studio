import crypto from 'crypto';
import { Types } from 'mongoose';
import config from 'config/env';
import { AppError } from 'middlewares/error';
import CostEstimate, { ICostEstimateDocument, IEstimateItem } from 'models/cost-estimate.model';
import UsageRecord from 'models/usage-record.model';
import { getSettings, requirePrice, tokenCost, upcomingPrice } from './pricing.service';

/** Stable hash of generation parameters (key order independent). */
export const hashParams = (params: Record<string, unknown>) => {
  const norm = (v: any): any =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v;
  return crypto.createHash('sha256').update(JSON.stringify(norm(params))).digest('hex');
};

/**
 * Gemini image tokens: ≤384px on both sides = 258 tokens; otherwise tiled
 * in crop units of floor(min(w,h)/1.5), 258 tokens per tile
 * (ai.google.dev/gemini-api/docs/image-understanding#token-calculation).
 */
export const imageTokens = (w: number, h: number) => {
  if (w <= 384 && h <= 384) return 258;
  const unit = Math.max(1, Math.floor(Math.min(w, h) / 1.5));
  return Math.ceil(w / unit) * Math.ceil(h / unit) * 258;
};

/** Rough text tokens when the token-count API is unavailable (Indic scripts tokenize denser). */
export const heuristicTokens = (text: string) => {
  const indic = (text.match(/[\u0900-\u0DFF]/g) || []).length;
  return Math.ceil((text.length - indic) / 4 + indic / 2.2);
};

export interface EstimateDraft {
  owner: Types.ObjectId | string;
  project: Types.ObjectId | string;
  kind: ICostEstimateDocument['kind'];
  provider: string;
  model: string;
  params: Record<string, unknown>;
  items: Omit<IEstimateItem, 'costUSD'>[];
  thoughtTokens: number;
  requests: number;
  tokenCountMethod: 'provider' | 'heuristic';
  assumptions: string[];
  local?: ICostEstimateDocument['local'];
}

/** Price a draft with the active price list, check budget and persist it. */
export const finalizeEstimate = async (draft: EstimateDraft): Promise<ICostEstimateDocument> => {
  const settings = await getSettings(draft.owner);
  const isLocal = draft.provider === 'local';
  const price = isLocal ? null : await requirePrice(draft.provider, draft.model, settings.pricingTier);
  const next = isLocal ? null : await upcomingPrice(draft.provider, draft.model, settings.pricingTier);
  const items: IEstimateItem[] = draft.items.map((i) => ({ ...i, costUSD: price ? tokenCost(price, i.inputTokens, i.outputTokens) : 0 }));
  const sum = (k: keyof IEstimateItem) => items.reduce((n, i) => n + (Number(i[k]) || 0), 0);
  const thoughtCost = price ? tokenCost(price, 0, draft.thoughtTokens) : 0;
  const costUSD = sum('costUSD') + thoughtCost;
  const budget = settings.budgetLimitUSD || 0;
  return CostEstimate.create({
    owner: draft.owner,
    project: draft.project,
    kind: draft.kind,
    provider: draft.provider,
    modelId: draft.model,
    paramsHash: hashParams(draft.params),
    params: draft.params,
    items,
    totals: {
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      thoughtTokens: draft.thoughtTokens,
      requests: draft.requests,
      characters: sum('characters') || undefined,
      words: sum('words') || undefined,
      durationSeconds: sum('durationSeconds') || undefined,
      costUSD,
    },
    local: draft.local,
    pricing: price
      ? {
          version: price.version,
          sourceUrl: price.sourceUrl,
          lastVerified: price.lastVerified,
          inputPerMillion: price.inputPerMillion,
          outputPerMillion: price.outputPerMillion,
          ...(next ? { nextChange: { effectiveFrom: next.effectiveFrom, inputPerMillion: next.inputPerMillion, outputPerMillion: next.outputPerMillion } } : {}),
        }
      : undefined,
    currency: { usdToInr: settings.usdToInr, updatedAt: settings.usdToInrUpdatedAt, source: settings.usdToInrSource },
    tokenCountMethod: draft.tokenCountMethod,
    assumptions: draft.assumptions,
    budgetLimitUSD: budget,
    withinBudget: !budget || costUSD <= budget,
    expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
  });
};

const ESTIMATE_MAX_AGE_MS = 60 * 60_000;

/**
 * Gatekeeper for paid generation: the client must send the id of an
 * estimate it showed to the user, for the same parameters, recently, and
 * within the budget limit.
 */
export const approveEstimate = async (
  owner: Types.ObjectId | string,
  estimateId: unknown,
  kind: ICostEstimateDocument['kind'],
  params: Record<string, unknown>
) => {
  if (!estimateId) throw new AppError('Show the cost estimate and confirm it before generating (estimateId required)', 428);
  const est = await CostEstimate.findOne({ _id: String(estimateId), owner, kind });
  if (!est) throw new AppError('Cost estimate not found', 404);
  if (est.paramsHash !== hashParams(params)) throw new AppError('Generation parameters changed since the estimate — re-estimate first', 409);
  if (Date.now() - est.createdAt.getTime() > ESTIMATE_MAX_AGE_MS) throw new AppError('Cost estimate expired — re-estimate first', 409);
  if (!est.withinBudget) {
    throw new AppError(`Estimated cost $${est.totals.costUSD.toFixed(4)} exceeds your budget limit of $${est.budgetLimitUSD} — raise the limit in Settings or reduce the selection`, 402);
  }
  if (est.job) throw new AppError('This estimate was already used — re-estimate first', 409);
  est.approvedAt = new Date();
  await est.save();
  return est;
};

export const serializeEstimate = async (e: ICostEstimateDocument) => {
  const actual = await UsageRecord.aggregate([
    { $match: { estimate: e._id } },
    { $group: { _id: null, costUSD: { $sum: '$costUSD' }, inputTokens: { $sum: '$inputTokens' }, outputTokens: { $sum: '$outputTokens' }, thoughtTokens: { $sum: '$thoughtTokens' }, audioSeconds: { $sum: '$audioSeconds' }, calls: { $sum: 1 } } },
  ]);
  return {
    id: String(e._id),
    kind: e.kind,
    provider: e.provider,
    model: e.modelId,
    params: e.params,
    items: e.items,
    totals: e.totals,
    local: e.local,
    pricing: e.pricing,
    currency: e.currency,
    costINR: e.currency?.usdToInr ? e.totals.costUSD * e.currency.usdToInr : undefined,
    tokenCountMethod: e.tokenCountMethod,
    assumptions: e.assumptions,
    budgetLimitUSD: e.budgetLimitUSD,
    withinBudget: e.withinBudget,
    approvedAt: e.approvedAt,
    job: e.job ? String(e.job) : undefined,
    actual: actual[0] ? { ...actual[0], _id: undefined } : null,
    createdAt: e.createdAt,
    isEstimate: true,
  };
};

export const thinkingFactor = () => (config.GEMINI_THINKING_LEVEL === 'high' || config.GEMINI_THINKING_LEVEL === 'xhigh' ? 1.5 : config.GEMINI_THINKING_LEVEL === 'medium' ? 0.8 : 0.3);
