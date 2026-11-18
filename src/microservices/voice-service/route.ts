import { Router } from 'express';
import { Middleware } from 'middlewares';
import { createRateLimiter } from 'middlewares/createRateLimiter';
import * as c from './voice.controller';
import * as v from './voice.validate';

const router = Router();
const validate = Middleware.requestValidate;
const aiLimiter = createRateLimiter({ limit: 120, windowMinutes: 15 });
router.use(Middleware.verifyToken);

// providers, voices, preview
router.get('/status', c.voiceStatus);
router.get('/voices', c.listVoices);
router.post('/preview', aiLimiter, validate(v.previewSchema), c.previewVoice);

// voice profiles & replication (consent required)
router.route('/profiles').post(validate(v.profileSchema), c.createProfile);
router.route('/profiles/:profileId').put(validate(v.profileUpdateSchema), c.updateProfile).delete(c.deleteProfile);
router.post('/profiles/:profileId/replicate', aiLimiter, c.audioUpload, c.replicateVoice);

// cost estimate (required before cloud generation)
router.post('/estimate', validate(v.ttsEstimateSchema), c.estimateAudio);

// generation
router.post('/generate', aiLimiter, validate(v.generateSchema), c.generateAudio);
router.post('/audio/:audioId/regenerate', aiLimiter, c.regenerateAudio);
router.get('/audio', c.listAudio);
router.delete('/audio/:audioId', c.deleteAudio);

// studio settings + price list
router.route('/settings').get(c.getStudioSettings).put(validate(v.settingsSchema), c.updateStudioSettings);
router.post('/settings/refresh-fx', c.refreshFx);
router.get('/pricing', c.pricingTable);

export default router;
