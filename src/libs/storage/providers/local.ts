import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
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

const cleanFolder = (folder?: string) =>
  folder ? folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '';

class LocalStorageProvider implements IStorageProvider {
  readonly name = 'local' as const;
  private baseDir: string;

  constructor() {
    if (!config.UPLOAD_BASE_DIR) {
      throw new AppError('UPLOAD_BASE_DIR is required for local storage', 500);
    }
    this.baseDir = path.resolve(process.cwd(), config.UPLOAD_BASE_DIR);
    ensureDirectoryExists(this.baseDir);
  }

  private newKey(folder: string, originalName: string) {
    const ext = path.extname(originalName).toLowerCase();
    const filename = `${uuidv4()}${ext}`;
    return folder ? `${folder}/${filename}` : filename;
  }

  async upload(
    file: Express.Multer.File,
    options?: UploadOptions
  ): Promise<UploadedFileResult> {
    const folder = cleanFolder(options?.folder);
    const dir = folder ? path.join(this.baseDir, folder) : this.baseDir;
    ensureDirectoryExists(dir);

    const ext = path.extname(file.originalname);
    const filename = `${uuidv4()}${ext}`;
    const key = folder ? `${folder}/${filename}` : filename;

    await fs.promises.writeFile(path.join(this.baseDir, key), file.buffer);

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
    const folder = cleanFolder(options.folder);
    const key = this.newKey(folder, options.originalName);
    const dest = this.localPath(key);
    ensureDirectoryExists(path.dirname(dest));
    await fs.promises.copyFile(localPath, dest);
    const { size } = await fs.promises.stat(dest);
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
    await fs.promises.copyFile(this.localPath(key), localPath);
  }

  async openRead(key: string, range?: ByteRange): Promise<StoredObjectStream> {
    const filePath = this.localPath(key);
    const { size } = await fs.promises.stat(filePath);
    return {
      stream: fs.createReadStream(filePath, range ? { start: range.start, end: range.end } : undefined),
      size,
    };
  }

  /** Resolve a key to a path inside baseDir — rejects traversal outside it */
  localPath(key: string): string {
    const resolved = path.resolve(this.baseDir, key);
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + path.sep)) {
      throw new AppError('Invalid storage key', 400);
    }
    return resolved;
  }

  async delete(key: string): Promise<void> {
    const filePath = this.localPath(key);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }

  getUrl(key: string): string {
    return `${config.BASE_URL}/uploads/${key.split(path.sep).join('/')}`;
  }
}

export default LocalStorageProvider;
