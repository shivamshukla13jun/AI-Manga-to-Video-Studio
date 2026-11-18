import JSZip from 'jszip';

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const extOf = (name: string) => name.slice(name.lastIndexOf('.')).toLowerCase();

interface MergedEntry {
  ext: string;
  size: number;
  blob: () => Promise<Blob>;
}

/** Uncompressed size without loading the entry (jszip internals, with fallback). */
const entrySize = async (z: JSZip.JSZipObject): Promise<number> => {
  const size = (z as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  return size ?? (await z.async('blob')).size;
};

/**
 * Merge several CBZ/ZIP chapters into ≤`maxMB` archives entirely in the
 * browser: images are pulled from each archive in natural reading order
 * (optionally dropping each chapter's first page) and repacked with STORE
 * compression — no recompression, no server round-trip.
 */
export const mergeCbzFiles = async (
  files: File[],
  opts: { skipFirstPage?: boolean; maxMB?: number } = {}
): Promise<File[]> => {
  const limit = (opts.maxMB ?? 48) * 1024 * 1024;
  const batches: MergedEntry[][] = [];
  let current: MergedEntry[] = [];
  let currentBytes = 0;

  for (const file of files) {
    const zip = await JSZip.loadAsync(file).catch(() => {
      throw new Error(`${file.name} is not a readable CBZ/ZIP archive`);
    });
    const images = Object.values(zip.files)
      .filter((z) => !z.dir && IMAGE_EXT.includes(extOf(z.name)))
      .sort((a, b) => collator.compare(a.name, b.name));
    const list = opts.skipFirstPage ? images.slice(1) : images;
    for (const z of list) {
      const size = await entrySize(z);
      if (current.length && currentBytes + size > limit) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push({ ext: extOf(z.name), size, blob: () => z.async('blob') });
      currentBytes += size;
    }
  }
  if (current.length) batches.push(current);
  if (!batches.length) throw new Error('No JPG, PNG or WebP images found in the selected archives');

  const out: File[] = [];
  for (const [bi, batch] of batches.entries()) {
    const zip = new JSZip();
    for (const [i, e] of batch.entries()) {
      zip.file(`page_${String(i + 1).padStart(4, '0')}${e.ext}`, await e.blob(), { compression: 'STORE' });
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    out.push(
      new File([blob], `merged-unit-${String(bi + 1).padStart(2, '0')}.cbz`, { type: 'application/vnd.comicbook+zip' })
    );
  }
  return out;
};
