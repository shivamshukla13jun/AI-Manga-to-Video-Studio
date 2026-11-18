import { Router } from 'express';
import { Middleware } from 'middlewares';
import { createRateLimiter } from 'middlewares/createRateLimiter';
import * as c from './story.controller';
import * as v from './story.validate';

const router = Router();
const validate = Middleware.requestValidate;
const aiLimiter = createRateLimiter({ limit: 120, windowMinutes: 15 });
router.use(Middleware.verifyToken);

router.get('/projects/:projectId/overview', c.projectOverview);

// cost estimates (shown before any paid AI call)
router.post('/estimate/scenes', validate(v.chapterSelectionSchema), c.estimateScenes);
router.post('/estimate/story', validate(v.storyEstimateSchema), c.estimateNarration);
router.get('/estimates/:estimateId', c.getEstimate);
router.get('/projects/:projectId/estimates', c.listEstimates);

// AI jobs
router.post('/detect', aiLimiter, validate(v.detectSchema), c.detectScenes);
router.post('/generate', aiLimiter, validate(v.generateSchema), c.generateStory);
router.post('/scenes/:sceneId/regenerate', aiLimiter, validate(v.forceSchema), c.regenerateScene);
router.post('/segments/:segmentId/rewrite', aiLimiter, validate(v.rewriteSchema), c.rewriteSegment);

// scene editor
router.get('/chapters/:chapterId/scenes', c.listChapterScenes);
router.post('/chapters/:chapterId/scenes', validate(v.sceneCreateSchema), c.createScene);
router.put('/chapters/:chapterId/scenes/reorder', validate(v.reorderSchema), c.reorderScenes);
router.post('/scenes/merge', validate(v.idsSchema), c.mergeScenes);
router.route('/scenes/:sceneId').put(validate(v.sceneUpdateSchema), c.updateScene).delete(c.deleteScene);
router.post('/scenes/:sceneId/split', validate(v.sceneSplitSchema), c.splitScene);
router.post('/scenes/:sceneId/restore', validate(v.restoreSchema), c.restoreScene);
router.put('/images/:imageId/panels', validate(v.panelsSchema), c.updatePanels);

// narration editor
router.get('/projects/:projectId/segments', c.listSegments);
router.post('/segments/merge', validate(v.idsSchema), c.mergeSegments);
router.put('/segments/reorder', validate(v.reorderSchema), c.reorderSegments);
router.route('/segments/:segmentId').put(validate(v.segmentUpdateSchema), c.updateSegment).delete(c.deleteSegment);
router.post('/segments/:segmentId/split', validate(v.segmentSplitSchema), c.splitSegment);
router.post('/segments/:segmentId/restore', validate(v.restoreSchema), c.restoreSegment);

// characters
router.route('/projects/:projectId/characters').get(c.listCharacters).post(validate(v.characterSchema), c.createCharacter);
router.route('/characters/:characterId').put(validate(v.characterSchema.partial()), c.updateCharacter).delete(c.deleteCharacter);

export default router;
