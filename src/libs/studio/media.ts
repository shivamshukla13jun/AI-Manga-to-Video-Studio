import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Types } from 'mongoose';
import config from 'config/env';
import File, { IFileDocument } from 'models/file.model';
import { storageService, deleteStoredFile } from 'libs/storage';
import { sha256File, mimeForExt, sanitizeFilename } from './paths';

type Id = Types.ObjectId | string;

/** Storage folder for a project's media: studio/projects/<projectId>/<sub> */
export const projectFolder = (projectId: Id, ...sub: string[]): string =>
  [config.STUDIO_STORAGE_FOLDER, 'projects', String(projectId), ...sub].join('/');

export interface StoreFileOptions {
  folder: string;
  originalName: string;
  mimetype?: string;
  owner?: Id;
  checksum?: string;
}

/**
 * Persist a local file through the configured storage provider and
 * record it in the existing File collection. Studio media is private:
 * it is only reachable through short-lived signed URLs.
 */
export const storeLocalFile = async (
  localPath: string,
  opts: StoreFileOptions
): Promise<IFileDocument> => {
  const originalName = sanitizeFilename(opts.originalName);
  const mimetype = opts.mimetype || mimeForExt(originalName);
  const checksum = opts.checksum || (await sha256File(localPath));
  const uploaded = await storageService.putFile(localPath, {
    folder: opts.folder,
    mimetype,
    originalName,
    private: true,
  });
  try {
    return await File.create({
      key: uploaded.key,
      url: uploaded.url,
      provider: uploaded.provider,
      originalName,
      mimetype,
      size: uploaded.size,
      folder: opts.folder,
      uploadedBy: opts.owner,
      checksum,
      isPrivate: true,
    });
  } catch (error) {
    await storageService.delete({ key: uploaded.key, provider: uploaded.provider }).catch(() => undefined);
    throw error;
  }
};

export const storeBuffer = async (buf: Buffer, opts: StoreFileOptions & { tempDir: string }) => {
  const tmp = path.join(opts.tempDir, `${crypto.randomUUID()}${path.extname(opts.originalName)}`);
  await fs.promises.writeFile(tmp, buf);
  try {
    return await storeLocalFile(tmp, opts);
  } finally {
    await fs.promises.unlink(tmp).catch(() => undefined);
  }
};

/** Make a stored file available as a local path (copy for remote providers). */
export const fetchToLocal = async (fileId: Id, destPath: string): Promise<string> => {
  const file = await File.findById(fileId);
  if (!file) throw new Error(`File ${fileId} not found`);
  await storageService.getFile({ key: file.key, provider: file.provider }, destPath);
  return destPath;
};

/** Direct path for local storage (no copy), else downloads into tempDir. */
export const resolveLocal = async (fileId: Id, tempDir: string): Promise<string> => {
  const file = await File.findById(fileId);
  if (!file) throw new Error(`File ${fileId} not found`);
  const direct = storageService.localPath({ key: file.key, provider: file.provider });
  if (direct && fs.existsSync(direct)) return direct;
  const dest = path.join(tempDir, `${file._id}${path.extname(file.originalName)}`);
  if (!fs.existsSync(dest)) {
    await storageService.getFile({ key: file.key, provider: file.provider }, dest);
  }
  return dest;
};

export const deleteFileById = async (fileId?: Id | null): Promise<void> => {
  if (!fileId) return;
  const file = await File.findById(fileId);
  if (!file) return;
  await deleteStoredFile({ key: file.key, provider: file.provider, fileId: file._id }).catch((e) =>
    console.error(`Failed to delete stored file ${file.key}:`, e)
  );
};

// ---------------------------------------------------------------------------
// Signed media URLs — <img>/<audio>/<video> tags and headless Chrome (render)
// cannot send bearer tokens, so access is granted with an HMAC + expiry that
// the API only hands out after checking project ownership.
// ---------------------------------------------------------------------------
const sign = (fileId: string, exp: number) =>
  crypto
    .createHmac('sha256', config.MEDIA_URL_SECRET as string)
    .update(`${fileId}.${exp}`)
    .digest('base64url');

export const signMediaPath = (fileId: Id, ttlSeconds = config.MEDIA_URL_TTL_SECONDS): string => {
  const id = String(fileId);
  // round expiry to the hour so URLs stay cache-friendly across requests
  const exp = Math.ceil((Date.now() / 1000 + ttlSeconds) / 3600) * 3600;
  return `/api/media/${id}?exp=${exp}&sig=${sign(id, exp)}`;
};

export const mediaUrl = (fileId?: Id | null, base = config.BASE_URL): string | null =>
  fileId ? `${base}${signMediaPath(fileId)}` : null;

export const verifyMediaSignature = (fileId: string, exp: string, sig: string): boolean => {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum * 1000 < Date.now() || !sig) return false;
  const expected = Buffer.from(sign(fileId, expNum));
  const given = Buffer.from(String(sig));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
};
