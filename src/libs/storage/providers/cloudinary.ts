import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { v2 as cloudinary } from 'cloudinary';
import config from 'config/env';
import { ensureDirectoryExists } from 'libs';
import { AppError } from 'middlewares/error';
import type {
  ByteRange,
  IStorageProvider,
  PutFileOptions,
  StoredObjectStream,
  UploadedFileResult,
  UploadOptions,
} from '../types';

// Keys written by putFile are "<resource_type>|<public_id>" so private
// raw/video assets can be resolved again (cloudinary.url needs the type).
const RESOURCE_SEP = '|';
const parseKey = (key: string) => {
  const idx = key.indexOf(RESOURCE_SEP);
  if (idx === -1) return { resourceType: 'image', publicId: key, typed: false };
  return { resourceType: key.slice(0, idx), publicId: key.slice(idx + 1), typed: true };
};

class CloudinaryStorageProvider implements IStorageProvider {
  readonly name = 'cloudinary' as const;

  constructor() {
    const missing = [
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET',
    ].filter((k) => !config[k as keyof typeof config]);
    if (missing.length) {
      throw new AppError(
        `Missing Cloudinary configuration: ${missing.join(', ')}`,
        500
      );
    }

    cloudinary.config({
      cloud_name: config.CLOUDINARY_CLOUD_NAME,
      api_key: config.CLOUDINARY_API_KEY,
      api_secret: config.CLOUDINARY_API_SECRET,
    });
  }

  async upload(
    file: Express.Multer.File,
    options?: UploadOptions
  ): Promise<UploadedFileResult> {
    const folder = options?.folder || config.CLOUDINARY_FOLDER;

    const result: any = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'auto',
        },
        (error, res) => (error ? reject(error) : resolve(res))
      );
      stream.end(file.buffer);
    });

    return {
      key: result.public_id,
      url: result.secure_url,
      provider: this.name,
      size: file.size,
      mimetype: file.mimetype,
      originalName: file.originalname,
    };
  }

  async putFile(localPath: string, options: PutFileOptions): Promise<UploadedFileResult> {
    const folder = options.folder || config.CLOUDINARY_FOLDER;
    const result: any = await cloudinary.uploader.upload(localPath, {
      folder,
      resource_type: 'auto',
      type: 'authenticated',
    });
    return {
      key: `${result.resource_type}${RESOURCE_SEP}${result.public_id}`,
      url: result.secure_url,
      provider: this.name,
      size: result.bytes,
      mimetype: options.mimetype,
      originalName: options.originalName,
    };
  }

  private resolveUrl(key: string) {
    const { resourceType, publicId, typed } = parseKey(key);
    return cloudinary.url(publicId, {
      secure: true,
      resource_type: resourceType,
      ...(typed ? { type: 'authenticated', sign_url: true } : {}),
    });
  }

  async openRead(key: string, range?: ByteRange): Promise<StoredObjectStream> {
    const res = await fetch(this.resolveUrl(key), {
      headers: range ? { Range: `bytes=${range.start}-${range.end ?? ''}` } : {},
    });
    if (!res.ok || !res.body) {
      throw new AppError(`Cloudinary download failed (${res.status})`, 502);
    }
    const total = res.headers.get('content-range')?.split('/')[1];
    return {
      stream: Readable.fromWeb(res.body as any),
      size: total ? Number(total) : Number(res.headers.get('content-length')) || undefined,
      contentType: res.headers.get('content-type') || undefined,
    };
  }

  async getFile(key: string, localPath: string): Promise<void> {
    const { stream } = await this.openRead(key);
    ensureDirectoryExists(path.dirname(localPath));
    await pipeline(stream, fs.createWriteStream(localPath));
  }

  async delete(key: string): Promise<void> {
    const { resourceType, publicId, typed } = parseKey(key);
    if (typed) {
      await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type: 'authenticated' });
      return;
    }
    await cloudinary.uploader.destroy(key, { resource_type: 'image' }).catch(async () => {
      await cloudinary.uploader.destroy(key, { resource_type: 'raw' });
    });
  }

  getUrl(key: string): string {
    return this.resolveUrl(key);
  }
}

export default CloudinaryStorageProvider;
