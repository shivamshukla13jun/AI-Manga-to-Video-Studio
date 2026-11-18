import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import config from 'config/env';

export const tempRoot = (): string => path.resolve(process.cwd(), config.STUDIO_TEMP_DIR);

/** Create a unique scratch directory; callers must remove it with `removeDir`. */
export const makeTempDir = async (prefix: string): Promise<string> => {
  const dir = path.join(tempRoot(), `${prefix}-${uuidv4()}`);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
};

export const removeDir = async (dir?: string): Promise<void> => {
  if (!dir) return;
  // never delete anything outside the studio temp root
  const root = tempRoot();
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(root + path.sep)) return;
  await fs.promises.rm(resolved, { recursive: true, force: true }).catch(() => undefined);
};

/** Join a relative name under `base`, throwing if the result escapes it. */
export const safeJoin = (base: string, ...parts: string[]): string => {
  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, ...parts);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Unsafe path: ${parts.join('/')}`);
  }
  return target;
};

/** Strip path separators, control and reserved characters from a user-provided filename. */
export const sanitizeFilename = (name: string, fallback = 'file'): string => {
  const base = path.basename(String(name || '')).normalize('NFKC');
  const cleaned = base
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
};

export const sha256File = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });

export const sha256Buffer = (buf: Buffer): string =>
  crypto.createHash('sha256').update(buf).digest('hex');

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/** Natural ordering: "page2" < "page10", case-insensitive. */
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b);

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.cbz': 'application/vnd.comicbook+zip',
  '.zip': 'application/zip',
  '.json': 'application/json',
};
/** Accepts a filename ("a.png") or a bare extension (".png"). */
export const mimeForExt = (name: string): string => {
  const ext = /^\.[^.]+$/.test(name) ? name : path.extname(name);
  return MIME_BY_EXT[ext.toLowerCase()] || 'application/octet-stream';
};
