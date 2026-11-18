import sharp from 'sharp';
import config from 'config/env';

sharp.cache(false);
sharp.concurrency(Math.max(1, Math.min(4, require('os').cpus().length - 1)));

export const TALL_RATIO = 2.2;

export interface ProbedImage {
  ok: boolean;
  width: number;
  height: number;
  format?: string;
  error?: string;
}

export const openSharp = (input: string | Buffer) =>
  sharp(input, { limitInputPixels: config.IMAGE_MAX_PIXELS, failOn: 'truncated' });

/**
 * Validate an image by decoding it fully (header-only metadata misses
 * truncated/corrupted files) while producing its thumbnail in one pass.
 */
export const probeAndThumbnail = async (
  inputPath: string,
  thumbPath: string
): Promise<ProbedImage> => {
  try {
    const meta = await openSharp(inputPath).metadata();
    if (!meta.width || !meta.height) throw new Error('Image has no dimensions');
    if (!['jpeg', 'png', 'webp', 'gif'].includes(String(meta.format))) {
      throw new Error(`Unsupported image format: ${meta.format}`);
    }
    await openSharp(inputPath)
      .rotate()
      .resize({ width: 320, height: 3200, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toFile(thumbPath);
    return { ok: true, width: meta.width, height: meta.height, format: meta.format };
  } catch (error: any) {
    return { ok: false, width: 0, height: 0, error: error?.message || 'Unreadable image' };
  }
};

export const isTallImage = (width: number, height: number) =>
  width > 0 && height / width >= TALL_RATIO;
