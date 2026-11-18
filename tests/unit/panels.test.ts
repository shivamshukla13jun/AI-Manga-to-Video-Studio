import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { detectPanels, mergeBreaks, tileRegion } from 'libs/studio/panels';
import { isSafeEntryName, guessChapterNumber } from 'libs/studio/archive';
import { naturalCompare, sanitizeFilename, mimeForExt } from 'libs/studio/paths';

const strip = async (width: number, heights: number[], gutter = 60, bg = '#ffffff') => {
  let y = gutter;
  const composites = heights.map((h, i) => {
    const c = { input: { create: { width: width - 80, height: h, channels: 3 as const, background: ['#3b5bdb', '#e8590c', '#2f9e44'][i % 3] } }, top: y, left: 40 };
    y += h + gutter;
    return c;
  });
  const height = heights.reduce((a, h) => a + h + gutter, gutter);
  return sharp({ create: { width, height, channels: 3, background: bg } }).composite(composites).png().toBuffer();
};

test('detects vertically stacked webtoon panels in order', async () => {
  const img = await strip(800, [700, 900, 600]);
  const panels = await detectPanels(img);
  assert.equal(panels.length, 3);
  const total = 60 * 4 + 2200;
  const expectedTop = [60, 820, 1780].map((v) => v / total);
  panels.forEach((p, i) => {
    assert.ok(Math.abs(p.y - expectedTop[i]) < 0.01, `panel ${i} top ${p.y} vs ${expectedTop[i]}`);
    assert.ok(Math.abs(p.x - 40 / 800) < 0.02, `panel ${i} left`);
    assert.ok(Math.abs(p.width - 720 / 800) < 0.02, `panel ${i} width`);
  });
});

test('splits a manga grid with right-to-left ordering', async () => {
  // 2x2 grid: top row [A | B], bottom row full width
  const img = await sharp({ create: { width: 1000, height: 1400, channels: 3, background: '#fff' } })
    .composite([
      { input: { create: { width: 440, height: 600, channels: 3, background: '#111' } }, top: 40, left: 40 },
      { input: { create: { width: 440, height: 600, channels: 3, background: '#555' } }, top: 40, left: 520 },
      { input: { create: { width: 920, height: 640, channels: 3, background: '#999' } }, top: 720, left: 40 },
    ])
    .png()
    .toBuffer();
  const ltr = await detectPanels(img);
  assert.equal(ltr.length, 3);
  assert.ok(ltr[0].x < ltr[1].x, 'left-to-right');
  const rtl = await detectPanels(img, { rtl: true });
  assert.ok(rtl[0].x > rtl[1].x, 'right-to-left for manga');
  assert.ok(rtl[2].y > 0.45, 'bottom panel last');
});

test('works on black gutters and returns full-bleed art as one region', async () => {
  const dark = await strip(600, [500, 500], 50, '#000000');
  assert.equal((await detectPanels(dark)).length, 2);
  const noise = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#888' } })
    .composite([{ input: { create: { width: 600, height: 300, channels: 3, background: '#222' } }, top: 300, left: 0 }])
    .png()
    .toBuffer();
  const full = await detectPanels(noise);
  assert.equal(full.length, 1);
});

test('tiles tall regions with overlap and maps spans', async () => {
  const tall = await sharp({ create: { width: 800, height: 12000, channels: 3, background: '#ccc' } }).png().toBuffer();
  const tiles = await tileRegion(tall, { x: 0, y: 0, width: 1, height: 1 });
  assert.ok(tiles.length >= 4, `got ${tiles.length} tiles`);
  assert.equal(tiles[0].start, 0);
  assert.equal(tiles[tiles.length - 1].end, 1);
  for (let i = 1; i < tiles.length; i++) assert.ok(tiles[i].start < tiles[i - 1].end, 'overlapping');
  const meta = await sharp(tiles[0].data).metadata();
  assert.equal(meta.width, 800);
  const merged = mergeBreaks([0.31, 0.3, 0.7, 0.705, 0.99, 0.01]);
  assert.equal(merged.length, 2);
  assert.ok(Math.abs(merged[0] - 0.305) < 1e-9 && Math.abs(merged[1] - 0.7025) < 1e-9);
});

test('archive and path safety helpers', () => {
  assert.equal(isSafeEntryName('../evil.png'), false);
  assert.equal(isSafeEntryName('a/../../evil.png'), false);
  assert.equal(isSafeEntryName('/abs.png'), false);
  assert.equal(isSafeEntryName('C:\\x.png'), false);
  assert.equal(isSafeEntryName('Chapter 1/001.png'), true);
  assert.deepEqual(['p10', 'p2', 'p1'].sort(naturalCompare), ['p1', 'p2', 'p10']);
  assert.equal(guessChapterNumber('The Sword - Chapter 012.cbz'), 12);
  assert.equal(guessChapterNumber('ch_5.5.cbz'), 5.5);
  assert.equal(guessChapterNumber('vol2 ep 7.cbz'), 7);
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('a<b>:c?.pdf'), 'a_b_c_.pdf');
  assert.equal(mimeForExt('.png'), 'image/png');
  assert.equal(mimeForExt('x.JPG'), 'image/jpeg');
});
