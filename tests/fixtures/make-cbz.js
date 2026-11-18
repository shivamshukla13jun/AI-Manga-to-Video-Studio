/**
 * Generates realistic test CBZ archives: tall manhwa-style strips with
 * white gutters between panels, natural-order filenames, a ComicInfo.xml,
 * plus "unsafe" archives for the security tests.
 * Usage: node tests/fixtures/make-cbz.js <outDir>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');

// Minimal ZIP writer (deflate) — avoids adding a runtime dependency for tests
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const writeZip = (file, entries) => {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data, store } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = store ? data : zlib.deflateRawSync(data);
    const method = store ? 0 : 8;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, cenBuf, end]));
};

const COLORS = ['#3b5bdb', '#e8590c', '#2f9e44', '#c2255c', '#5f3dc4', '#1098ad'];
/** Tall strip: `panels` coloured panels separated by 60px white gutters. */
const strip = async (width, panelHeights, seed, format = 'png') => {
  const gutter = 60;
  const height = panelHeights.reduce((a, h) => a + h + gutter, gutter);
  let y = gutter;
  const composites = panelHeights.map((h, i) => {
    const svg = `<svg width="${width - 80}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="${COLORS[(seed + i) % COLORS.length]}"/>
      <circle cx="${(width - 80) / 2}" cy="${h / 2}" r="${Math.min(h, width) / 5}" fill="#fff" opacity="0.6"/>
      <text x="30" y="70" font-size="48" fill="#fff" font-family="sans-serif">Panel ${seed}.${i + 1}</text></svg>`;
    const c = { input: Buffer.from(svg), top: y, left: 40 };
    y += h + gutter;
    return c;
  });
  const img = sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).composite(composites);
  return format === 'jpeg' ? img.jpeg({ quality: 88 }).toBuffer() : format === 'webp' ? img.webp({ quality: 90 }).toBuffer() : img.png().toBuffer();
};

const main = async () => {
  const out = path.resolve(process.argv[2] || 'tmp/fixtures');
  fs.mkdirSync(out, { recursive: true });
  for (let ch = 1; ch <= 6; ch++) {
    const entries = [];
    // filenames deliberately out of lexical order: 1, 2, 10 → natural sort must give 1,2,10
    const names = ch === 1 ? ['page1', 'page2', 'page10'] : ['001', '002', '003'];
    for (let p = 0; p < names.length; p++) {
      const fmt = ['png', 'jpeg', 'webp'][p % 3];
      const ext = fmt === 'jpeg' ? 'jpg' : fmt;
      entries.push({ name: `Chapter ${ch}/${names[p]}.${ext}`, data: await strip(800, [700, 900, 600].slice(0, 2 + (p % 2)), ch * 10 + p, fmt) });
    }
    entries.push({ name: 'ComicInfo.xml', data: Buffer.from(`<?xml version="1.0"?><ComicInfo><Series>The Legendary Sword</Series><Number>${ch}</Number><Title>Chapter ${ch}</Title></ComicInfo>`) });
    entries.push({ name: '__MACOSX/._junk', data: Buffer.from('junk') });
    writeZip(path.join(out, `chapter_${String(ch).padStart(3, '0')}.cbz`), entries);
  }
  // corrupted page: valid PNG header, truncated body
  const good = await strip(600, [500, 500], 99);
  writeZip(path.join(out, 'broken_page.cbz'), [
    { name: '01.png', data: good },
    { name: '02.png', data: good.subarray(0, Math.floor(good.length / 3)) },
  ]);
  writeZip(path.join(out, 'traversal.cbz'), [{ name: '../../evil.png', data: good }]);
  // highly compressible 40 MB entry → ratio check (zip bomb)
  writeZip(path.join(out, 'bomb.cbz'), [{ name: 'a.png', data: Buffer.alloc(40 * 1024 * 1024) }]);
  writeZip(path.join(out, 'no_images.cbz'), [{ name: 'readme.txt', data: Buffer.from('hello') }]);
  fs.writeFileSync(path.join(out, 'not_a_zip.cbz'), 'this is not a zip');
  console.log(`fixtures written to ${out}`);
};
main().catch((e) => { console.error(e); process.exit(1); });
