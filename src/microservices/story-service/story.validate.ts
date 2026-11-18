import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const bbox = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0.001).max(1),
  height: z.number().min(0.001).max(1),
});
const region = z.object({ image: objectId, bbox, order: z.number().optional() });
const dialogue = z.object({
  speaker: z.string().max(120).optional(),
  text: z.string().min(1).max(2000),
  kind: z.enum(['speech', 'thought', 'narration', 'sfx']).default('speech'),
  uncertain: z.boolean().default(false),
});
const lang = z.string().min(2).max(16);

export const chapterSelectionSchema = z.object({
  projectId: objectId,
  chapterIds: z.array(objectId).min(1).max(500),
});

export const detectSchema = chapterSelectionSchema.extend({
  estimateId: objectId.optional(),
  overwriteEdited: z.boolean().default(false),
  redetectPanels: z.boolean().default(false),
});

export const storyEstimateSchema = chapterSelectionSchema.extend({
  language: lang.optional(),
  mode: z.enum(['original', 'recap']).optional(),
});

export const generateSchema = storyEstimateSchema.extend({
  estimateId: objectId.optional(),
  overwriteEdited: z.boolean().default(false),
  /** true → run inline in this request (errors returned directly); false → background job */
  direct: z.boolean().default(false),
});

export const sceneUpdateSchema = z.object({
  title: z.string().max(300).optional(),
  characters: z.array(z.string().max(120)).max(50).optional(),
  location: z.string().max(300).optional(),
  action: z.string().max(3000).optional(),
  emotion: z.string().max(120).optional(),
  description: z.string().max(5000).optional(),
  events: z.array(z.string().max(1000)).max(100).optional(),
  dialogues: z.array(dialogue).max(300).optional(),
  storyContext: z.string().max(3000).optional(),
  regions: z.array(region).min(1).max(50).optional(),
});

export const sceneCreateSchema = sceneUpdateSchema.extend({
  regions: z.array(region).min(1).max(50),
  afterSceneId: objectId.optional(),
});

export const idsSchema = z.object({ ids: z.array(objectId).min(2).max(50) });
export const reorderSchema = z.object({ ids: z.array(objectId).min(1) });

export const sceneSplitSchema = z.object({
  /** split the region list before this index… */
  regionIndex: z.number().int().min(1).optional(),
  /** …or cut a single region at a vertical position (0..1 of the region) */
  atY: z.number().gt(0).lt(1).optional(),
});

export const restoreSchema = z.object({ historyIndex: z.number().int().min(0) });
export const forceSchema = z.object({ force: z.boolean().default(false) });

export const segmentUpdateSchema = z.object({
  title: z.string().max(300).optional(),
  narration: z.string().max(20000).optional(),
});

export const segmentSplitSchema = z.object({
  at: z.number().int().min(1),
  sceneSplitIndex: z.number().int().min(1).optional(),
});

export const rewriteSchema = z.object({
  action: z.enum(['regenerate', 'shorten', 'expand', 'tone', 'translate']),
  tone: z.string().max(60).optional(),
  language: lang.optional(),
  force: z.boolean().default(false),
});

export const panelsSchema = z.object({ panels: z.array(bbox).max(100) });

export const characterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().max(120)).max(20).optional(),
  description: z.string().max(2000).optional(),
  appearance: z.string().max(2000).optional(),
  role: z.string().max(120).optional(),
  pronunciation: z.string().max(200).optional(),
});
