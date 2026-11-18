import { Router } from 'express';
import { Middleware } from 'middlewares';
import * as c from './video.controller';
import * as v from './video.validate';

const router = Router();
const validate = Middleware.requestValidate;
router.use(Middleware.verifyToken);

router.route('/projects').get(c.listVideos).post(validate(v.createSchema), c.createVideo);
router.route('/projects/:videoId').get(c.getVideoProject).delete(c.deleteVideo);
router.put('/projects/:videoId/timeline', validate(v.timelineSchema), c.saveTimeline);
router.post('/projects/:videoId/rebuild', validate(v.rebuildSchema), c.rebuild);
router.post('/projects/:videoId/render', c.renderVideo);
router.post('/projects/:videoId/tracks', validate(v.trackCreateSchema), c.addTrack);
router.route('/projects/:videoId/tracks/:trackId').put(validate(v.trackUpdateSchema), c.updateTrack).delete(c.deleteTrack);
router.post('/projects/:videoId/tracks/:trackId/clips', validate(v.clipAddSchema), c.addClip);
router.route('/projects/:videoId/tracks/:trackId/clips/:clipId').put(validate(v.clipUpdateSchema), c.updateClip).delete(c.deleteClip);
router.post('/projects/:videoId/tracks/:trackId/clips/:clipId/split', validate(v.clipSplitSchema), c.splitClip);
router.post('/projects/:videoId/clips/merge', validate(v.mergeClipsSchema), c.mergeClips);
router.post('/projects/:videoId/versions', validate(v.versionSchema), c.createVersion);
router.post('/projects/:videoId/restore', validate(v.restoreSchema), c.restoreVersion);

export default router;
