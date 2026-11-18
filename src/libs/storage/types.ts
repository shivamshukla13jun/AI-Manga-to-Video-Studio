import 'multer';
import type { StorageProviderName } from 'config/env';
import type { Types } from 'mongoose';

export interface UploadOptions {
  folder?: string;
}

export interface UploadedFileResult {
  key: string;
  url: string;
  provider: StorageProviderName;
  size: number;
  mimetype: string;
  originalName: string;
}

export interface PutFileOptions {
  folder?: string;
  mimetype: string;
  originalName: string;
  /** Keep the object private (no public ACL) — studio media is served via signed URLs */
  private?: boolean;
}

export interface ByteRange {
  start: number;
  end?: number;
}

export interface StoredObjectStream {
  stream: NodeJS.ReadableStream;
  size?: number;
  contentType?: string;
}

export interface IStorageProvider {
  readonly name: StorageProviderName;
  upload(
    file: Express.Multer.File,
    options?: UploadOptions
  ): Promise<UploadedFileResult>;
  /** Upload a file from local disk without buffering it in memory */
  putFile(localPath: string, options: PutFileOptions): Promise<UploadedFileResult>;
  /** Download an object to a local path (workers need real files for sharp/ffmpeg/yauzl) */
  getFile(key: string, localPath: string): Promise<void>;
  /** Stream an object, optionally a byte range (for media seeking) */
  openRead(key: string, range?: ByteRange): Promise<StoredObjectStream>;
  /** Absolute path for providers backed by local disk */
  localPath?(key: string): string;
  delete(key: string): Promise<void>;
  getUrl(key: string): string;
}

// Reference to a stored object — enough info to delete it later
// from both the provider bucket/dir and the File collection.
export interface StoredFileRef {
  key: string;
  provider: StorageProviderName;
  fileId?: Types.ObjectId | string;
}

export type { StorageProviderName };
