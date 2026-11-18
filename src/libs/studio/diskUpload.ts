import fs from 'fs';
import path from 'path';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { AppError } from 'middlewares/error';
import { decryptBodyFields } from 'middlewares/encryption';
import { tempRoot } from './paths';

const GROUPS = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  audio: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/webm', 'audio/flac', 'audio/mp4', 'audio/x-m4a', 'audio/aac'],
} as const;

/**
 * Private studio uploads: multer writes to the studio temp dir (no memory
 * buffering), handlers persist via `storeLocalFile`, and the temp file is
 * always removed when the response finishes.
 */
export const diskUpload = (
  fields: { name: string; maxCount?: number }[],
  opts: { types: (keyof typeof GROUPS)[]; maxSize: number }
): RequestHandler => {
  const dir = path.join(tempRoot(), 'incoming');
  const allowed: string[] = opts.types.flatMap((t) => [...GROUPS[t]]);
  const mw = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase().slice(0, 8)}`),
    }),
    limits: { fileSize: opts.maxSize, files: fields.reduce((n, f) => n + (f.maxCount || 1), 0) },
    fileFilter: (_req, file, cb) =>
      allowed.includes(file.mimetype)
        ? cb(null, true)
        : cb(new AppError(`File type "${file.mimetype}" is not allowed`, 400) as any),
  }).fields(fields);

  const handler = (req: Request, res: Response, next: NextFunction) => {
    res.on('close', () => {
      const files = Object.values((req.files as Record<string, Express.Multer.File[]>) || {}).flat();
      files.forEach((f) => fs.promises.unlink(f.path).catch(() => undefined));
    });
    mw(req, res, (err?: any) => {
      if (err) {
        return next(err instanceof multer.MulterError ? new AppError(`File upload failed: ${err.message}`, 400) : err);
      }
      Promise.resolve(decryptBodyFields(req)).then(() => next()).catch(next);
    });
  };
  (handler as any)._upload = { kind: 'fields', fields: fields.map((f) => f.name) };
  return handler;
};

export const uploadedFile = (req: Request, field: string): Express.Multer.File | undefined =>
  (req.files as Record<string, Express.Multer.File[]> | undefined)?.[field]?.[0];
