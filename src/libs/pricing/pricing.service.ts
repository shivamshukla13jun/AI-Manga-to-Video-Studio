import fs from 'fs';
import config from 'config/env';
import path from 'path';
import { Types } from 'mongoose';
import PricingConfiguration, { IPricingConfigurationDocument } from 'models/pricing-configuration.model';
import StudioSettings, { IStudioSettingsDocument } from 'models/studio-settings.model';
import { AppError } from 'middlewares/error';

const PRICING_DIR = path.resolve(__dirname, '../../config/pricing');
const FX_URL = (config as any).FX_API_BASE || 'https://open.er-api.com/v6/latest/USD';

/** Upsert every versioned price list in src/config/pricing/*.json. Idempotent. */
export const seedPricing = async (): Promise<number> => {
  if (!fs.existsSync(PRICING_DIR)) return 0;
  let count = 0;
  for (const file of fs.readdirSync(PRICING_DIR).filter((f) => f.endsWith('.json'))) {
    const doc = JSON.parse(fs.readFileSync(path.join(PRICING_DIR, file), 'utf8'));
    for (const e of doc.entries) {
      await PricingConfiguration.updateOne(
        { provider: e.provider, modelId: e.model, tier: e.tier || 'standard', effectiveFrom: new Date(e.effectiveFrom), version: doc.version },
        {
          $set: {
            kind: e.kind,
            inputPerMillion: e.inputPerMillion,
            outputPerMillion: e.outputPerMillion,
            audioTokensPerSecond: e.audioTokensPerSecond,
            effectiveTo: e.effectiveTo ? new Date(e.effectiveTo) : undefined,
            sourceUrl: e.sourceUrl || doc.sourceUrl,
            lastVerified: new Date(doc.lastVerified),
            notes: e.notes || doc.notes,
          },
          $setOnInsert: { active: true, currency: 'USD' },
        },
        { upsert: true }
      );
      count++;
    }
  }
  return count;
};

/** Price row in effect at `at` (latest version wins if several overlap). */
export const getPrice = async (
  provider: string,
  model: string,
  tier: 'standard' | 'batch' = 'standard',
  at = new Date()
): Promise<IPricingConfigurationDocument | null> =>
  PricingConfiguration.findOne({
    provider,
    modelId: model,
    tier,
    active: true,
    effectiveFrom: { $lte: at },
    $or: [{ effectiveTo: { $exists: false } }, { effectiveTo: null }, { effectiveTo: { $gt: at } }],
  }).sort({ lastVerified: -1, effectiveFrom: -1 });

export const requirePrice = async (provider: string, model: string, tier: 'standard' | 'batch' = 'standard') => {
  const price = await getPrice(provider, model, tier);
  if (!price) {
    throw new AppError(`No pricing configured for ${provider}/${model} (${tier}). Add it under Settings → Pricing.`, 422);
  }
  return price;
};

export const tokenCost = (price: IPricingConfigurationDocument, inputTokens: number, outputTokens: number) =>
  (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000;

/** Next scheduled price change for the model, if any (shown next to estimates). */
export const upcomingPrice = async (provider: string, model: string, tier: 'standard' | 'batch' = 'standard') =>
  PricingConfiguration.findOne({ provider, modelId: model, tier, active: true, effectiveFrom: { $gt: new Date() } }).sort({ effectiveFrom: 1 });

export const getSettings = async (owner: Types.ObjectId | string): Promise<IStudioSettingsDocument> => {
  const existing = await StudioSettings.findOne({ owner });
  return existing || StudioSettings.create({ owner });
};

/** Fetch today's USD→INR rate; the rate, timestamp and source are stored with the settings. */
export const refreshExchangeRate = async (owner: Types.ObjectId | string) => {
  const res = await fetch(FX_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new AppError(`Exchange-rate service unavailable (${res.status})`, 502);
  const json: any = await res.json();
  const rate = Number(json?.rates?.INR);
  if (!Number.isFinite(rate) || rate <= 0) throw new AppError('Exchange-rate service returned no INR rate', 502);
  const settings = await getSettings(owner);
  settings.usdToInr = rate;
  settings.usdToInrUpdatedAt = json.time_last_update_unix ? new Date(json.time_last_update_unix * 1000) : new Date();
  settings.usdToInrSource = json.provider || FX_URL;
  await settings.save();
  return settings;
};

export const listPrices = async (): Promise<IPricingConfigurationDocument[]> =>
  PricingConfiguration.find({}).sort({ provider: 1, modelId: 1, kind: 1, effectiveFrom: 1 });

export const serializePrice = (p: IPricingConfigurationDocument) => ({
  id: String(p._id),
  provider: p.provider,
  model: p.modelId,
  kind: p.kind,
  tier: p.tier,
  version: p.version,
  currency: p.currency,
  inputPerMillion: p.inputPerMillion,
  outputPerMillion: p.outputPerMillion,
  audioTokensPerSecond: p.audioTokensPerSecond,
  effectiveFrom: p.effectiveFrom,
  effectiveTo: p.effectiveTo,
  sourceUrl: p.sourceUrl,
  lastVerified: p.lastVerified,
  notes: p.notes,
  active: p.active,
});
