import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const chapterNumber = z.coerce.number().min(0).max(100000);
const lang = z.string().min(2).max(16);

export const projectCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  language: lang.optional(),
  narrationLanguage: lang.optional(),
  narrationMode: z.enum(['original', 'recap']).optional(),
  tags: z.array(z.string().max(40)).max(30).optional(),
  /** Set false to skip the public-metadata character/cover import. */
  fetchMetadata: z.boolean().optional(),
});

export const projectUpdateSchema = projectCreateSchema.partial().extend({
  status: z.enum(['active', 'archived']).optional(),
  continuitySummary: z.string().max(20000).optional(),
});

export const uploadCreateSchema = z.object({
  fileName: z.string().min(1).max(255),
  size: z.coerce.number().int().positive(),
  fingerprint: z.string().max(300).optional(),
  chapterNumber: chapterNumber.optional(),
  chapterTitle: z.string().max(200).optional(),
  replaceChapterId: objectId.optional(),
  /** Leading pages to drop at extraction (e.g. 1 = skip the cover page) */
  skipPages: z.coerce.number().int().min(0).max(500).optional(),
  /** After extraction, merge this chapter into a ≤50MB PDF unit */
  autoMerge: z.boolean().optional(),
});

export const uploadCompleteSchema = z.object({
  allowDuplicate: z.boolean().optional(),
});

export const chapterUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  number: chapterNumber.optional(),
});

export const chapterReorderSchema = z.object({
  chapterIds: z.array(objectId).min(1),
});

export const chapterRenumberSchema = z.object({
  items: z
    .array(z.object({ id: objectId, number: chapterNumber, title: z.string().trim().min(1).max(200).optional() }))
    .min(1),
});

export const groupSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    startNumber: chapterNumber,
    endNumber: chapterNumber,
    chapterIds: z.array(objectId).optional(),
  })
  .refine((g) => g.endNumber >= g.startNumber, { message: 'End chapter must be ≥ start chapter', path: ['endNumber'] });

export const mergeSchema = z
  .object({
    chapterIds: z.array(objectId).min(1).max(500).optional(),
    maxSizeMB: z.coerce.number().min(1).max(50).optional(),
  })
  .optional()
  .default({});
