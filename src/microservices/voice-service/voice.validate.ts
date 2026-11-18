import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const providerSchema = z.enum(['gemini', 'local']);

export const previewSchema = z.object({
  provider: providerSchema,
  voiceId: z.string().min(1).max(200),
  text: z.string().min(1).max(500),
  language: z.string().min(2).max(10).default('hi'),
  speed: z.number().min(0.5).max(2).default(1),
});

export const ttsEstimateSchema = z.object({
  projectId: objectId,
  segmentIds: z.array(objectId).min(1).max(1000),
  provider: providerSchema,
  voiceId: z.string().min(1).max(200),
  speed: z.number().min(0.5).max(2).default(1),
});

export const generateSchema = ttsEstimateSchema.extend({
  estimateId: objectId.optional(),
});

export const profileSchema = z.object({
  name: z.string().min(1).max(120),
  provider: providerSchema.default('local'),
  kind: z.enum(['prebuilt', 'custom']).default('prebuilt'),
  voiceId: z.string().min(1).max(200),
  engine: z.string().max(100).optional(),
  language: z.string().min(2).max(10).default('hi'),
  languages: z.array(z.string().max(10)).max(30).default([]),
  gender: z.string().max(20).optional(),
  description: z.string().max(1000).optional(),
  styleHint: z.string().max(500).optional(),
});

export const profileUpdateSchema = profileSchema.partial().omit({ provider: true, kind: true, voiceId: true });

export const consentSchema = z.object({
  consentNote: z.string().min(10).max(500),
});

export const audioQuerySchema = z.object({
  project: objectId,
  chapter: objectId.optional(),
  segment: objectId.optional(),
  purpose: z.enum(['narration', 'preview', 'reference']).optional(),
  status: z.enum(['queued', 'processing', 'ready', 'failed']).optional(),
});

export const settingsSchema = z.object({
  budgetLimitUSD: z.number().min(0).max(100000).optional(),
  confirmAboveUSD: z.number().min(0).max(100000).optional(),
  displayCurrency: z.enum(['USD', 'INR']).optional(),
  pricingTier: z.enum(['standard', 'batch']).optional(),
  defaultTtsProvider: providerSchema.optional(),
  defaultVoiceProfile: objectId.nullish(),
  aiProvider: z.enum(['gemini', 'local']).optional(),
  narrationLanguage: z.string().min(2).max(16).optional(),
  narrationMode: z.enum(['original', 'recap']).optional(),
  wordsPerMinute: z.record(z.string(), z.number().min(40).max(400)).optional(),
});
