import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
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

class S3StorageProvider implements IStorageProvider {
  readonly name = 's3' as const;
  private client: S3Client;
  private bucket: string;

  constructor() {
    const missing = [
      'AWS_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_S3_BUCKET',
    ].filter((k) => !config[k as keyof typeof config]);
    if (missing.length) {
      throw new AppError(
        `Missing AWS S3 configuration: ${missing.join(', ')}`,
        500
      );
    }

    this.bucket = config.AWS_S3_BUCKET as string;
    this.client = new S3Client({
      region: config.AWS_REGION as string,
      credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID as string,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY as string,
      },
      ...(config.AWS_S3_ENDPOINT
        ? { endpoint: config.AWS_S3_ENDPOINT, forcePathStyle: true }
        : {}),
    });
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

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
    );

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
    const { size } = await fs.promises.stat(localPath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fs.createReadStream(localPath),
        ContentLength: size,
        ContentType: options.mimetype,
      })
    );
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
    const { stream } = await this.openRead(key);
    ensureDirectoryExists(path.dirname(localPath));
    await pipeline(stream, fs.createWriteStream(localPath));
  }

  async openRead(key: string, range?: ByteRange): Promise<StoredObjectStream> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end ?? ''}` } : {}),
      })
    );
    const total = res.ContentRange?.split('/')[1];
    return {
      stream: res.Body as Readable,
      size: total && total !== '*' ? Number(total) : res.ContentLength,
      contentType: res.ContentType,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }

  getUrl(key: string): string {
    if (config.AWS_PUBLIC_URL) {
      return `${config.AWS_PUBLIC_URL.replace(/\/+$/, '')}/${key}`;
    }
    return `https://${this.bucket}.s3.${config.AWS_REGION}.amazonaws.com/${key}`;
  }
}

export default S3StorageProvider;
