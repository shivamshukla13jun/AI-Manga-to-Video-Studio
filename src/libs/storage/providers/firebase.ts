import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import config from 'config/env';
import { ensureDirectoryExists } from 'libs';
import { admin, firebaseApp } from 'libs/firebase/firebase';
import { AppError } from 'middlewares/error';
import type {
  ByteRange,
  IStorageProvider,
  PutFileOptions,
  StoredObjectStream,
  UploadedFileResult,
  UploadOptions,
} from '../types';

class FirebaseStorageProvider implements IStorageProvider {
  readonly name = 'firebase' as const;
  private bucket: ReturnType<
    ReturnType<typeof admin.storage>['bucket']
  >;

  constructor() {
    if (!config.FIREBASE_STORAGE_BUCKET) {
      throw new AppError(
        'FIREBASE_STORAGE_BUCKET is required for firebase storage',
        500
      );
    }
    this.bucket = admin
      .storage(firebaseApp)
      .bucket(config.FIREBASE_STORAGE_BUCKET);
  }

  private newKey(folder: string | undefined, originalName: string) {
    const clean = folder ? folder.replace(/^\/+|\/+$/g, '') : '';
    const ext = path.extname(originalName);
    return clean ? `${clean}/${uuidv4()}${ext}` : `${uuidv4()}${ext}`;
  }

  async upload(
    file: Express.Multer.File,
    options?: UploadOptions
  ): Promise<UploadedFileResult> {
    const key = this.newKey(options?.folder, file.originalname);

    const bucketFile = this.bucket.file(key);
    await bucketFile.save(file.buffer, {
      metadata: { contentType: file.mimetype },
    });
    await bucketFile.makePublic();

    return {
      key,
      url: this.getUrl(key),
      provider: this.name,
      size: file.size,
      mimetype: file.mimetype,
      originalName: file.originalname,
    };
  }

  async putFile(localPath: string, options: PutFileOptions): Promise<UploadedFileResult> {
    const key = this.newKey(options.folder, options.originalName.toLowerCase());
    await this.bucket.upload(localPath, {
      destination: key,
      resumable: true,
      metadata: { contentType: options.mimetype },
    });
    if (!options.private) await this.bucket.file(key).makePublic();
    const { size } = await fs.promises.stat(localPath);
    return {
      key,
      url: this.getUrl(key),
      provider: this.name,
      size,
      mimetype: options.mimetype,
      originalName: options.originalName,
    };
  }

  async getFile(key: string, localPath: string): Promise<void> {
    ensureDirectoryExists(path.dirname(localPath));
    await pipeline(this.bucket.file(key).createReadStream(), fs.createWriteStream(localPath));
  }

  async openRead(key: string, range?: ByteRange): Promise<StoredObjectStream> {
    const file = this.bucket.file(key);
    const [metadata] = await file.getMetadata();
    return {
      stream: file.createReadStream(range ? { start: range.start, end: range.end } : {}),
      size: Number(metadata.size),
      contentType: metadata.contentType,
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.file(key).delete({ ignoreNotFound: true });
  }

  getUrl(key: string): string {
    return `https://storage.googleapis.com/${this.bucket.name}/${key}`;
  }
}

export default FirebaseStorageProvider;
