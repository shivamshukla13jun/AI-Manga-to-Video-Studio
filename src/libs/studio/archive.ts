import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import yauzl, { Entry, ZipFile } from 'yauzl';
import config from 'config/env';
import { naturalCompare } from './paths';

export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

export class ArchiveError extends Error {
  constructor(message: string, public code = 'INVALID_ARCHIVE') {
    super(message);
  }
}

export interface ArchiveImageEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  entry: Entry;
}

export interface ArchiveListing {
  entryCount: number;
  images: ArchiveImageEntry[];
  skipped: string[];
  comicInfo?: { title?: string; number?: string; series?: string };
}

export interface ArchiveLimits {
  maxEntries: number;
  maxTotalUncompressed: number;
  maxEntrySize: number;
  maxCompressionRatio: number;
}

export const defaultLimits = (): ArchiveLimits => ({
  maxEntries: config.CBZ_MAX_ENTRIES,
  maxTotalUncompressed: config.CBZ_MAX_UNCOMPRESSED_SIZE,
  maxEntrySize: config.CBZ_MAX_ENTRY_SIZE,
  maxCompressionRatio: config.CBZ_MAX_COMPRESSION_RATIO,
});

/** Reject absolute paths, drive letters, ".." segments and NUL bytes. */
export const isSafeEntryName = (name: string): boolean => {
  if (!name || name.includes('\0')) return false;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split('/').some((seg) => seg === '..');
};

const isJunk = (name: string) => {
  const parts = name.replace(/\\/g, '/').split('/');
  const base = parts[parts.length - 1];
  return (
    parts.some((p) => p === '__MACOSX' || p.startsWith('.')) ||
    base.toLowerCase() === 'thumbs.db' ||
    base.toLowerCase() === 'desktop.ini'
  );
};

const openZip = (filePath: string): Promise<ZipFile> =>
  new Promise((resolve, reject) =>
    yauzl.open(
      filePath,
      { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: false },
      (err, zip) => (err || !zip ? reject(new ArchiveError(`Not a valid CBZ/ZIP archive: ${err?.message}`)) : resolve(zip))
    )
  );

const readEntryBuffer = (zip: ZipFile, entry: Entry, max: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    if (entry.uncompressedSize > max) return reject(new ArchiveError(`${entry.fileName} is too large`));
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err);
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (c: Buffer) => {
        total += c.length;
        if (total > max) stream.destroy(new ArchiveError(`${entry.fileName} exceeds its declared size`));
        else chunks.push(c);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });

const parseComicInfo = (xml: string) => {
  const pick = (tag: string) => xml.match(new RegExp(`<${tag}>([^<]{1,300})</${tag}>`, 'i'))?.[1]?.trim();
  return { title: pick('Title'), number: pick('Number'), series: pick('Series') };
};

/**
 * Open a CBZ, validate every entry against the safety limits and return
 * the image entries in natural reading order. The zip handle stays open
 * so entries can be streamed; always call `close()`.
 */
export const openComicArchive = async (filePath: string, limits = defaultLimits()) => {
  const zip = await openZip(filePath);
  const images: ArchiveImageEntry[] = [];
  const skipped: string[] = [];
  let entryCount = 0;
  let totalUncompressed = 0;
  let comicInfoEntry: Entry | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', (e) => reject(new ArchiveError(`Corrupted archive: ${e.message}`)));
      zip.on('end', () => resolve());
      zip.on('entry', (entry: Entry) => {
        try {
          entryCount += 1;
          if (entryCount > limits.maxEntries) {
            throw new ArchiveError(`Archive has more than ${limits.maxEntries} entries`, 'TOO_MANY_ENTRIES');
          }
          const name = entry.fileName;
          if (!isSafeEntryName(name)) {
            throw new ArchiveError(`Unsafe path in archive: ${name}`, 'PATH_TRAVERSAL');
          }
          if (/\/$/.test(name) || isJunk(name)) return zip.readEntry();

          totalUncompressed += entry.uncompressedSize;
          if (totalUncompressed > limits.maxTotalUncompressed) {
            throw new ArchiveError('Archive expands beyond the allowed size (possible zip bomb)', 'ARCHIVE_TOO_LARGE');
          }
          if (entry.uncompressedSize > limits.maxEntrySize) {
            throw new ArchiveError(`Entry ${name} is larger than allowed`, 'ENTRY_TOO_LARGE');
          }
          const ratio = entry.compressedSize > 0 ? entry.uncompressedSize / entry.compressedSize : 0;
          if (entry.uncompressedSize > 1024 * 1024 && ratio > limits.maxCompressionRatio) {
            throw new ArchiveError(`Suspicious compression ratio for ${name} (possible zip bomb)`, 'ZIP_BOMB');
          }

          const ext = path.extname(name).toLowerCase();
          if (IMAGE_EXTENSIONS.includes(ext)) {
            images.push({ name, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize, entry });
          } else if (path.basename(name).toLowerCase() === 'comicinfo.xml') {
            comicInfoEntry = entry;
          } else {
            skipped.push(name);
          }
          zip.readEntry();
        } catch (e) {
          reject(e);
        }
      });
      zip.readEntry();
    });

    images.sort((a, b) => naturalCompare(a.name, b.name));

    let comicInfo: ArchiveListing['comicInfo'];
    if (comicInfoEntry) {
      const xml = await readEntryBuffer(zip, comicInfoEntry, 1024 * 1024).catch(() => null);
      if (xml) comicInfo = parseComicInfo(xml.toString('utf8'));
    }

    return {
      listing: { entryCount, images, skipped, comicInfo } as ArchiveListing,
      /** Stream one entry to disk, enforcing its declared size */
      async extractTo(item: ArchiveImageEntry, destPath: string): Promise<void> {
        const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
          zip.openReadStream(item.entry, (err, s) => (err || !s ? reject(err) : resolve(s)))
        );
        let written = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            written += chunk.length;
            if (written > item.uncompressedSize || written > limits.maxEntrySize) {
              cb(new ArchiveError(`${item.name} exceeds its declared size`, 'ZIP_BOMB'));
            } else cb(null, chunk);
          },
        });
        await pipeline(stream, limiter, fs.createWriteStream(destPath));
      },
      readBuffer: (item: ArchiveImageEntry) => readEntryBuffer(zip, item.entry, limits.maxEntrySize),
      close: () => zip.close(),
    };
  } catch (error) {
    zip.close();
    throw error;
  }
};

/** Quick ZIP magic-number check ("PK\x03\x04" or empty archive "PK\x05\x06"). */
export const looksLikeZip = async (filePath: string): Promise<boolean> => {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    return buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05);
  } finally {
    await fh.close();
  }
};

/** Best-effort chapter number from a filename like "Chapter 012.cbz" or "ch_5.5". */
export const guessChapterNumber = (fileName: string): number | undefined => {
  const base = path.basename(fileName, path.extname(fileName));
  const tagged = base.match(/(?:ch(?:apter)?|ep(?:isode)?|#)\s*[._-]?\s*(\d+(?:\.\d+)?)/i);
  const any = tagged || base.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
  return any ? Number(any[1]) : undefined;
};
