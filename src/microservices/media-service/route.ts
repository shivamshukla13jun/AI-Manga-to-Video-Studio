import { Router } from 'express';
import config from 'config/env';
import File from 'models/file.model';
import { storageService } from 'libs/storage';
import { verifyMediaSignature } from 'libs/studio/media';
import { asyncHandler, assertObjectId } from 'libs/studio/http';
import { AppError } from 'middlewares/error';
import { sanitizeFilename } from 'libs/studio/paths';

const router = Router();

/**
 * GET /api/media/:fileId?exp=&sig=
 * Streams a private studio file after verifying its HMAC signature.
 * Supports HTTP Range requests so audio/video can seek. `?download=1`
 * forces a download with the original filename.
 */
router.get(
  '/:fileId',
  asyncHandler(async (req, res) => {
    const id = assertObjectId(req.params.fileId, 'file id');
    if (!verifyMediaSignature(id, String(req.query.exp), String(req.query.sig))) {
      throw new AppError('Media link is invalid or expired', 403);
    }
    const file = await File.findById(id);
    if (!file) throw new AppError('File not found', 404);

    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // allow the studio frontend to embed media (PDF preview iframe); nobody else
    res.removeHeader('X-Frame-Options');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self' ${[config.FRONTEND_URL, ...config.CORS_ORIGIN].filter(Boolean).join(' ')}`
    );
    if (req.query.download) {
      res.attachment(sanitizeFilename(String(req.query.name || file.originalName)));
    }

    const ref = { key: file.key, provider: file.provider };
    const local = storageService.localPath(ref);
    if (local) {
      // sendFile handles Range/ETag/If-Modified-Since
      return res.sendFile(local, { headers: { 'Content-Type': file.mimetype }, dotfiles: 'deny' });
    }

    const size = file.size;
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', file.mimetype);
    if (range && size) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      const { stream } = await storageService.openRead(ref, { start, end });
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      stream.pipe(res);
      return;
    }
    const { stream } = await storageService.openRead(ref);
    if (size) res.setHeader('Content-Length', String(size));
    stream.pipe(res);
  })
);

export default router;
