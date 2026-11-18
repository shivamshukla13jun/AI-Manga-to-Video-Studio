/**
 * Manga library end-to-end: real chunked CBZ uploads, safe extraction,
 * natural page ordering, duplicate detection, broken-page recovery,
 * signed media access and unsafe-archive rejection.
 * Requires a running API (npm run dev) and fixtures (npm run test:fixtures).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { api, login, uploadCbz, waitForJob, BASE } = require('./helpers');

const FIX = path.resolve('tmp/fixtures');
let token;
let project;

test.before(async () => {
  token = await login();
  const r = await api(token, 'POST', '/api/manga/projects', { title: `The Legendary Sword ${Date.now()}`, language: 'ko' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  project = r.body.data;
});

test('public registration cannot escalate role', async () => {
  const email = `escalate-${Date.now()}@example.com`;
  const r = await api(null, 'POST', '/api/auth/register', {
    name: 'Mallory',
    email,
    password: 'Password-123',
    confirmPassword: 'Password-123',
    role: 'superadmin',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.role, 'user');
});

test('uploads chapter 1 with resumable chunks and extracts pages in natural order', async () => {
  const { start, complete } = await uploadCbz(token, project.id, path.join(FIX, 'chapter_001.cbz'), { chapterTitle: 'The Beginning' });
  assert.equal(start.status, 201);
  assert.equal(complete.status, 201, JSON.stringify(complete.body));
  const { chapter, job } = complete.body.data;
  assert.equal(chapter.number, 1, 'chapter number from filename');
  assert.equal(chapter.title, 'The Beginning');
  const done = await waitForJob(token, job.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  const imgs = (await api(token, 'GET', `/api/manga/chapters/${chapter.id}/images`)).body.data;
  assert.deepEqual(
    imgs.map((i) => i.entryName),
    ['Chapter 1/page1.png', 'Chapter 1/page2.jpg', 'Chapter 1/page10.webp']
  );
  assert.ok(imgs.every((i) => i.status === 'ok' && i.width === 800 && i.thumbnailUrl));
  assert.ok(imgs.every((i) => i.isTall), 'tall strips detected');

  const media = await fetch(imgs[0].url);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'image/png');
  const ranged = await fetch(imgs[0].url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  const tampered = await fetch(imgs[0].url.replace(/sig=[^&]+/, 'sig=forged'));
  assert.equal(tampered.status, 403);
  const publicStatic = await fetch(`${BASE}/uploads/studio/projects/${project.id}/archives/x.cbz`);
  assert.equal(publicStatic.status, 404, 'studio media not publicly served');
});

test('resumes an interrupted upload without re-sending received chunks', async () => {
  const first = await uploadCbz(token, project.id, path.join(FIX, 'chapter_002.cbz'), { chapterNumber: 2 }, { interruptAfter: 0 });
  assert.ok(first.interrupted);
  const again = await uploadCbz(token, project.id, path.join(FIX, 'chapter_002.cbz'), { chapterNumber: 2 });
  assert.equal(again.start.body.data.resumed, true);
  assert.equal(again.start.body.data.id, first.start.body.data.id);
  assert.equal(again.complete.status, 201, JSON.stringify(again.complete.body));
  await waitForJob(token, again.complete.body.data.job.id);
});

test('detects duplicate archives', async () => {
  const dup = await uploadCbz(token, project.id, path.join(FIX, 'chapter_001.cbz'), { chapterNumber: 99 });
  assert.equal(dup.complete.status, 409);
  assert.match(dup.complete.body.message, /identical/);
});

test('rejects unsafe or invalid archives', async () => {
  const cases = [
    ['traversal.cbz', /unsafe|invalid relative path|not a valid/i],
    ['bomb.cbz', /zip bomb|compression ratio/i],
    ['no_images.cbz', /no JPG, PNG or WebP/i],
    ['not_a_zip.cbz', /not a valid/i],
  ];
  for (const [file, re] of cases) {
    const r = await uploadCbz(token, project.id, path.join(FIX, file), { chapterNumber: 500 });
    assert.equal(r.complete.status, 400, `${file}: ${JSON.stringify(r.complete.body)}`);
    assert.match(r.complete.body.message, re, file);
  }
});

test('flags broken pages without dropping them and supports manual replacement', async () => {
  const r = await uploadCbz(token, project.id, path.join(FIX, 'broken_page.cbz'), { chapterNumber: 7 });
  assert.equal(r.complete.status, 201, JSON.stringify(r.complete.body));
  const job = await waitForJob(token, r.complete.body.data.job.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.result.brokenImages, 1);
  const chapterId = r.complete.body.data.chapter.id;
  const imgs = (await api(token, 'GET', `/api/manga/chapters/${chapterId}/images`)).body.data;
  assert.equal(imgs.length, 2);
  assert.equal(imgs[1].status, 'broken');

  const reextract = await api(token, 'POST', `/api/manga/images/${imgs[1].id}/reextract`);
  const rj = await waitForJob(token, reextract.body.data.id);
  assert.equal(rj.status, 'failed', 'corrupt inside CBZ cannot be recovered by re-extraction');
  assert.match(rj.error.message, /Replace it manually/);

  const good = await (await fetch(imgs[0].url)).arrayBuffer();
  const fd = new FormData();
  fd.append('image', new Blob([good], { type: 'image/png' }), 'fixed.png');
  const rep = await api(token, 'POST', `/api/manga/images/${imgs[1].id}/replace`, fd);
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.equal(rep.body.data.status, 'replaced');
  assert.equal(rep.body.data.hasReplacement, true);
  assert.ok(rep.body.data.originalUrl, 'original CBZ page preserved');
});

test('chapter management: rename, renumber swap, reorder, groups', async () => {
  const list = (await api(token, 'GET', `/api/manga/projects/${project.id}/chapters`)).body.data;
  const c1 = list.find((c) => c.number === 1);
  const c2 = list.find((c) => c.number === 2);
  const ren = await api(token, 'PUT', `/api/manga/chapters/${c2.id}`, { title: 'Awakening' });
  assert.equal(ren.body.data.title, 'Awakening');
  const clash = await api(token, 'PUT', `/api/manga/chapters/${c2.id}`, { number: 1 });
  assert.equal(clash.status, 409);
  const swap = await api(token, 'PUT', `/api/manga/projects/${project.id}/chapters/renumber`, {
    items: [
      { id: c1.id, number: 2 },
      { id: c2.id, number: 1 },
    ],
  });
  assert.equal(swap.status, 200, JSON.stringify(swap.body));
  const ids = list.map((c) => c.id).reverse();
  const reorder = await api(token, 'PUT', `/api/manga/projects/${project.id}/chapters/reorder`, { chapterIds: ids });
  assert.equal(reorder.status, 200);
  const after = (await api(token, 'GET', `/api/manga/projects/${project.id}/chapters`)).body.data;
  assert.deepEqual(after.map((c) => c.id), ids);
  const g = await api(token, 'POST', `/api/manga/projects/${project.id}/groups`, { name: 'The Beginning', startNumber: 1, endNumber: 5 });
  assert.equal(g.status, 201);
  const bad = await api(token, 'POST', `/api/manga/projects/${project.id}/groups`, { name: 'Bad', startNumber: 5, endNumber: 1 });
  assert.equal(bad.status, 400);
});

test('other users cannot access the project', async () => {
  const email = `other-${Date.now()}@example.com`;
  await api(null, 'POST', '/api/auth/register', { name: 'Other', email, password: 'Password-123', confirmPassword: 'Password-123' });
  const lr = await api(null, 'POST', '/api/auth/login', { email, password: 'Password-123' });
  const other = lr.body.data.accessToken;
  const r = await api(other, 'GET', `/api/manga/projects/${project.id}/chapters`);
  assert.equal(r.status, 404);
});
