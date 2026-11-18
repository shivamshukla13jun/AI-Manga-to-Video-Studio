import { Router } from 'express';
import config from 'config/env';
import { Middleware } from 'middlewares';
import { createRateLimiter } from 'middlewares/createRateLimiter';
import { diskUpload } from 'libs/studio/diskUpload';
import * as c from './manga.controller';
import {
  chapterRenumberSchema,
  chapterReorderSchema,
  chapterUpdateSchema,
  groupSchema,
  mergeSchema,
  projectCreateSchema,
  projectUpdateSchema,
  uploadCompleteSchema,
  uploadCreateSchema,
} from './manga.validate';

const router = Router();
const v = Middleware.requestValidate;
// generous: a 2 GB CBZ is ~256 chunks of 8 MB
const chunkLimiter = createRateLimiter({ limit: 3000, windowMinutes: 15 });
const imageUpload = (field: string) => diskUpload([{ name: field }], { types: ['image'], maxSize: config.CBZ_MAX_ENTRY_SIZE });

router.use(Middleware.verifyToken);

router.route('/projects').get(c.listProjects).post(v(projectCreateSchema), c.createProject);
router.post('/projects/:projectId/fetch-metadata', c.fetchMetadata);
router
  .route('/projects/:projectId')
  .get(c.getProjectDetails)
  .put(v(projectUpdateSchema), c.updateProject)
  .delete(c.removeProject);
router.post('/projects/:projectId/cover', imageUpload('cover'), c.uploadCover);

router.get('/projects/:projectId/chapters', c.listChapters);
router.post('/projects/:projectId/merge', v(mergeSchema), c.mergeChapters);
router.put('/projects/:projectId/chapters/reorder', v(chapterReorderSchema), c.reorderChapters);
router.put('/projects/:projectId/chapters/renumber', v(chapterRenumberSchema), c.renumberChapters);
router.route('/chapters/:chapterId').put(v(chapterUpdateSchema), c.updateChapter).delete(c.removeChapter);
router.post('/chapters/:chapterId/extract', c.reextractChapter);
router.get('/chapters/:chapterId/images', c.listChapterImages);

router.delete('/images/:imageId', c.removeImage);
router.post('/images/:imageId/reextract', c.reextractImage);
router.post('/images/:imageId/replace', imageUpload('image'), c.replaceImage);
router.post('/images/:imageId/restore', c.restoreImage);

router.route('/projects/:projectId/groups').get(c.listGroups).post(v(groupSchema), c.createGroup);
router.route('/groups/:groupId').put(v(groupSchema), c.updateGroup).delete(c.removeGroup);

router.route('/projects/:projectId/uploads').get(c.listUploads).post(v(uploadCreateSchema), c.startUpload);
router.route('/uploads/:uploadId').get(c.getUpload).delete(c.cancelUpload);
// raw binary body (application/octet-stream) — streamed to disk, never buffered
router.put('/uploads/:uploadId/chunks/:index', chunkLimiter, c.putChunk);
router.post('/uploads/:uploadId/complete', v(uploadCompleteSchema), c.finishUpload);

export default router;
