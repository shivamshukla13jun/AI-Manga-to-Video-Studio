import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

const keyframe = z.object({
  at: z.number().min(0),
  scale: z.number().min(0.05).max(20).default(1),
  x: z.number().default(0),
  y: z.number().default(0),
  opacity: z.number().min(0).max(1).optional(),
  easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']).default('linear'),
});

const transition = z.object({
  type: z.enum(['none', 'fade', 'crossfade', 'slide-left', 'slide-right', 'zoom', 'wipe']).default('none'),
  duration: z.number().min(0).max(5).default(0),
});

export const clipSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(200).optional(),
  label: z.string().max(200).optional(),
  kind: z.enum(['image', 'audio', 'video', 'text']),
  start: z.number().min(0),
  duration: z.number().min(0.05).max(36000),
  mediaStart: z.number().min(0).default(0),
  gain: z.number().min(0).max(4).default(1),
  muted: z.boolean().default(false),
  scene: objectId.optional(),
  image: objectId.optional(),
  audio: objectId.optional(),
  segment: objectId.optional(),
  text: z.string().max(5000).optional(),
  animation: z.object({ type: z.enum(['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down', 'ken-burns', 'custom']), keyframes: z.array(keyframe).max(200).default([]) }).default({ type: 'ken-burns', keyframes: [] }),
  transitionIn: transition.default({ type: 'none', duration: 0 }),
  transitionOut: transition.default({ type: 'none', duration: 0 }),
  backdrop: z.boolean().default(false),
});

export const trackSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(['background', 'image', 'narration', 'music', 'sfx', 'subtitle', 'overlay']),
  name: z.string().min(1).max(100),
  muted: z.boolean().default(false),
  locked: z.boolean().default(false),
  order: z.number().default(0),
  clips: z.array(clipSchema).max(5000).default([]),
});

export const createSchema = z.object({
  mangaProjectId: objectId,
  name: z.string().min(1).max(200),
  language: z.string().min(2).max(10).default('hi'),
  mode: z.enum(['original', 'recap']).default('recap'),
  chapterIds: z.array(objectId).optional(),
  settings: z
    .object({
      width: z.number().int().min(240).max(7680).default(1920),
      height: z.number().int().min(240).max(7680).default(1080),
      fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).default(30),
      layout: z.enum(['blur-fill', 'fit', 'fill', 'original']).default('blur-fill'),
      bgBlur: z.number().min(0).max(100).default(40),
      bgDim: z.number().min(0).max(1).default(0.55),
      targetDurationSec: z.number().min(5).max(7200).optional(),
    })
    .partial()
    .optional(),
});

export const timelineSchema = z.object({
  baseRevision: z.number().int().min(0),
  tracks: z.array(trackSchema).max(20),
  label: z.string().max(100).optional(),
});

export const clipUpdateSchema = clipSchema.partial();
export const clipSplitSchema = z.object({ at: z.number().min(0) });
export const clipAddSchema = z.object({
  trackId: z.string(),
  clip: clipSchema.omit({ id: true }),
});
export const trackCreateSchema = z.object({
  kind: trackSchema.shape.kind,
  name: z.string().min(1).max(100),
});
export const trackUpdateSchema = z.object({ name: z.string().max(100).optional(), muted: z.boolean().optional(), locked: z.boolean().optional(), order: z.number().optional() });
export const versionSchema = z.object({ label: z.string().min(1).max(100) });
export const restoreSchema = z.object({ index: z.number().int().min(0) });
export const mergeClipsSchema = z.object({ trackId: z.string(), ids: z.array(z.string()).min(2) });
export const rebuildSchema = z.object({ chapterIds: z.array(objectId).optional() });
