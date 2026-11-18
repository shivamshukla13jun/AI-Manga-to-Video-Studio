import config from 'config/env';
import { openSharp } from './images';

/** Normalized rectangle (0..1). */
export interface NBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number;
}

const ANALYSIS_WIDTH = 480;
const GUTTER_FRACTION = 0.985;
const BG_TOLERANCE = 30;
const MAX_DEPTH = 5;

/**
 * Detect comic panels with a recursive XY-cut over background-coloured
 * gutters. Works for both page-style manga (grids, RTL with `rtl`) and
 * vertical webtoon strips (panels separated by tall white/black gaps).
 * Returns normalized boxes in reading order. A region without gutters
 * (full-bleed art) is returned whole — the AI pass refines it.
 */
export const detectPanels = async (input: string | Buffer, opts: { rtl?: boolean } = {}): Promise<NBox[]> => {
  const meta = await openSharp(input).metadata();
  const srcW = meta.width || 0;
  const srcH = meta.height || 0;
  if (!srcW || !srcH) return [];
  const w = Math.min(ANALYSIS_WIDTH, srcW);
  const { data, info } = await openSharp(input)
    .rotate()
    .greyscale()
    .resize({ width: w, kernel: 'nearest' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const px = (x: number, y: number) => data[y * W + x];

  // Background colour = median of the outer border
  const border: number[] = [];
  for (let x = 0; x < W; x += 2) border.push(px(x, 0), px(x, H - 1));
  for (let y = 0; y < H; y += 4) border.push(px(0, y), px(W - 1, y));
  border.sort((a, b) => a - b);
  const bg = border[Math.floor(border.length / 2)];
  const isBg = (v: number) => Math.abs(v - bg) <= BG_TOLERANCE;

  const rowFrac = (y: number, r: Rect) => {
    let n = 0;
    for (let x = r.x0; x < r.x1; x++) if (isBg(px(x, y))) n++;
    return n / Math.max(1, r.x1 - r.x0);
  };
  const colFrac = (x: number, r: Rect) => {
    let n = 0;
    for (let y = r.y0; y < r.y1; y++) if (isBg(px(x, y))) n++;
    return n / Math.max(1, r.y1 - r.y0);
  };

  const minGap = Math.max(3, Math.round(W * 0.012));
  const minBand = Math.max(10, Math.round(W * 0.05));

  /** Split [start,end) along an axis into content bands separated by gutters. */
  const bands = (start: number, end: number, isGutter: (i: number) => boolean) => {
    const out: [number, number][] = [];
    let i = start;
    let bandStart = -1;
    while (i < end) {
      if (isGutter(i)) {
        let j = i;
        while (j < end && isGutter(j)) j++;
        if (j - i >= minGap || i === start || j === end) {
          if (bandStart !== -1) out.push([bandStart, i]);
          bandStart = -1;
          i = j;
          continue;
        }
      }
      if (bandStart === -1) bandStart = i;
      i++;
    }
    if (bandStart !== -1) out.push([bandStart, end]);
    return out.filter(([a, b]) => b - a >= minBand);
  };

  const trim = (r: Rect): Rect | null => {
    let { x0, y0, x1, y1 } = r;
    while (y0 < y1 && rowFrac(y0, { x0, y0, x1, y1 }) >= GUTTER_FRACTION) y0++;
    while (y1 > y0 && rowFrac(y1 - 1, { x0, y0, x1, y1 }) >= GUTTER_FRACTION) y1--;
    while (x0 < x1 && colFrac(x0, { x0, y0, x1, y1 }) >= GUTTER_FRACTION) x0++;
    while (x1 > x0 && colFrac(x1 - 1, { x0, y0, x1, y1 }) >= GUTTER_FRACTION) x1--;
    if (x1 - x0 < minBand || y1 - y0 < minBand) return null;
    return { x0, y0, x1, y1 };
  };

  const leaves: Rect[] = [];
  const cut = (r: Rect, depth: number) => {
    const t = trim(r);
    if (!t) return;
    if (depth >= MAX_DEPTH) return void leaves.push(t);
    const rows = bands(t.y0, t.y1, (y) => rowFrac(y, t) >= GUTTER_FRACTION);
    if (rows.length > 1) {
      rows.forEach(([a, b]) => cut({ x0: t.x0, x1: t.x1, y0: a, y1: b }, depth + 1));
      return;
    }
    const cols = bands(t.x0, t.x1, (x) => colFrac(x, t) >= GUTTER_FRACTION);
    if (cols.length > 1) {
      (opts.rtl ? [...cols].reverse() : cols).forEach(([a, b]) => cut({ x0: a, x1: b, y0: t.y0, y1: t.y1 }, depth + 1));
      return;
    }
    leaves.push(t);
  };
  cut({ x0: 0, y0: 0, x1: W, y1: H }, 0);

  const area = W * H;
  return leaves
    .filter((l) => (l.x1 - l.x0) * (l.y1 - l.y0) >= area * 0.002)
    .map((l) => ({
      x: l.x0 / W,
      y: l.y0 / H,
      width: (l.x1 - l.x0) / W,
      height: (l.y1 - l.y0) / H,
    }));
};

export const toPixels = (b: NBox, width: number, height: number) => {
  const left = Math.max(0, Math.floor(b.x * width));
  const top = Math.max(0, Math.floor(b.y * height));
  return {
    left,
    top,
    width: Math.max(1, Math.min(width - left, Math.round(b.width * width))),
    height: Math.max(1, Math.min(height - top, Math.round(b.height * height))),
  };
};

/** Crop a normalized region, scaled to at most `maxWidth`, as JPEG for AI input / thumbnails. */
export const cropRegion = async (input: string | Buffer, b: NBox, maxWidth = 1024, quality = 85) => {
  const meta = await openSharp(input).metadata();
  const r = toPixels(b, meta.width!, meta.height!);
  return openSharp(input)
    .extract(r)
    .resize({ width: Math.min(maxWidth, r.width), withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality })
    .toBuffer();
};

export interface RegionTile {
  data: Buffer;
  /** tile span inside the region, normalized to the region's height */
  start: number;
  end: number;
}

/**
 * Split a (tall) region into overlapping tiles at analysis resolution so
 * the vision model sees details; returns each tile's span so detections
 * can be mapped back to original coordinates.
 */
export const tileRegion = async (input: string | Buffer, b: NBox, maxWidth = 1024): Promise<RegionTile[]> => {
  const meta = await openSharp(input).metadata();
  const r = toPixels(b, meta.width!, meta.height!);
  const outW = Math.min(maxWidth, r.width);
  const scale = r.width / outW; // source px per output px
  const tileH = Math.round(config.AI_TILE_HEIGHT * scale);
  const overlap = Math.round(config.AI_TILE_OVERLAP * scale);
  if (r.height <= tileH * 1.15) {
    return [{ data: await cropRegion(input, b, maxWidth), start: 0, end: 1 }];
  }
  const tiles: RegionTile[] = [];
  for (let top = 0; top < r.height; top += tileH - overlap) {
    const height = Math.min(tileH, r.height - top);
    const data = await openSharp(input)
      .extract({ left: r.left, top: r.top + top, width: r.width, height })
      .resize({ width: outW })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer();
    tiles.push({ data, start: top / r.height, end: (top + height) / r.height });
    if (top + height >= r.height) break;
  }
  return tiles;
};

/** Merge scene-break positions reported by overlapping tiles (dedupe within `eps`). */
export const mergeBreaks = (positions: number[], eps = 0.03): number[] => {
  const sorted = positions.filter((p) => p > 0.02 && p < 0.98).sort((a, b) => a - b);
  const out: number[] = [];
  for (const p of sorted) {
    if (!out.length || p - out[out.length - 1] > eps) out.push(p);
    else out[out.length - 1] = (out[out.length - 1] + p) / 2;
  }
  return out;
};
