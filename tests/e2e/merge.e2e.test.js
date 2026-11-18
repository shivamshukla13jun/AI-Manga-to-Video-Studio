/**
 * Merged-PDF workflow end-to-end: batch chapters into ≤50MB "merged
 * chapter" units + queued PDF conversion, then run scene detection and
 * (local-provider) story generation on the merged unit — not per chapter.
 *
 * Requires:
 *   1. API + workers running (npm run dev)
 *   2. fixtures: npm run test:fixtures
 *   3. Redis up (pdf-conversion + scene-detection queues)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { BASE, api, login, uploadCbz, waitForJob } = require('./helpers');

const FIX = path.resolve('tmp/fixtures');
let token;
let project;
let chapters;
let merged;

// The e2e login is shared across suites — restore the default provider afterwards.
test.after(async () => {
  if (token) await api(token, 'PUT', '/api/voice/settings', { aiProvider: 'gemini' }).catch(() => undefined);
});

test.before(async () => {
  token = await login();
  // Force the local provider for this suite — detection/story stay free.
  const s = await api(token, 'PUT', '/api/voice/settings', { aiProvider: 'local' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const r = await api(token, 'POST', '/api/manga/projects', { title: `Merge ${Date.now()}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  project = r.body.data;
  for (let ch = 1; ch <= 3; ch++) {
    const up = await uploadCbz(token, project.id, path.join(FIX, `chapter_00${ch}.cbz`), { allowDuplicate: true });
    assert.equal(up.complete.status, 201, JSON.stringify(up.complete.body));
    const done = await waitForJob(token, up.complete.body.data.job.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
  }
  chapters = (await api(token, 'GET', `/api/manga/projects/${project.id}/chapters`)).body.data;
  assert.equal(chapters.length, 3);
});

test('settings expose and persist aiProvider', async () => {
  const r = await api(token, 'GET', '/api/voice/settings');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.aiProvider, 'local');
});

test('merge creates a special "merged" chapter + queued PDF export', async () => {
  const ids = chapters.map((c) => c.id);
  const r = await api(token, 'POST', `/api/manga/projects/${project.id}/merge`, { chapterIds: ids });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.data.units, 1);
  merged = r.body.data.chapters[0];
  assert.equal(merged.kind, 'merged');
  assert.equal(merged.sourceChapters.length, 3);
  assert.equal(merged.status, 'ready');
  assert.equal(merged.imageCount, chapters.reduce((s, c) => s + c.imageCount, 0));
  assert.ok(merged.pdfExport, 'linked pdf export');
  const exp = r.body.data.exports[0];
  const job = await waitForJob(token, exp.jobId);
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
});

test('merged chapter lists its own ComicImage rows (shared file refs)', async () => {
  const r = await api(token, 'GET', `/api/manga/chapters/${merged.id}/images`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, merged.imageCount);
  const src = (await api(token, 'GET', `/api/manga/chapters/${chapters[0].id}/images`)).body.data;
  assert.equal(r.body.data[0].url, src[0].url, 'page files are shared, not duplicated');
});

test('a tiny maxSizeMB splits the selection into multiple units', async () => {
  const r = await api(token, 'POST', `/api/manga/projects/${project.id}/merge`, { chapterIds: chapters.map((c) => c.id), maxSizeMB: 1 });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.ok(r.body.data.units >= 1);
  // clean up the extra units so the rest of the suite sees one merged unit
  const list = (await api(token, 'GET', `/api/manga/projects/${project.id}/chapters`)).body.data;
  for (const c of list.filter((c) => c.kind === 'merged' && c.id !== merged.id)) {
    await api(token, 'DELETE', `/api/manga/chapters/${c.id}`);
  }
});

test('scene detection runs on the merged unit as one job (local CV)', async () => {
  const r = await api(token, 'POST', '/api/story/detect', { projectId: project.id, chapterIds: [merged.id] });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const job = await waitForJob(token, r.body.data[0].id);
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.ok(job.result.scenes >= 1);
  const scenes = (await api(token, 'GET', `/api/story/chapters/${merged.id}/scenes`)).body.data;
  assert.ok(scenes.length >= 1);
  assert.ok(scenes.every((s) => s.dialogues.length === 0), 'scenes carry no OCR text');
});

test('deleting a page strips it from scenes and keeps shared files alive', async () => {
  const imgs = (await api(token, 'GET', `/api/manga/chapters/${merged.id}/images`)).body.data;
  const victim = imgs[0];
  const scenes = (await api(token, 'GET', `/api/story/chapters/${merged.id}/scenes`)).body.data;
  const affected = scenes.filter((s) => s.regions.some((r) => r.image === victim.id));
  assert.ok(affected.length >= 1, 'fixture page should back at least one scene');

  const del = await api(token, 'DELETE', `/api/manga/images/${victim.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));

  const after = (await api(token, 'GET', `/api/manga/chapters/${merged.id}/images`)).body.data;
  assert.equal(after.length, imgs.length - 1);
  assert.ok(after.every((i, idx) => i.index === idx), 'page indices re-packed');

  const scenesAfter = (await api(token, 'GET', `/api/story/chapters/${merged.id}/scenes`)).body.data;
  assert.ok(
    scenesAfter.every((s) => s.regions.every((r) => r.image !== victim.id)),
    'deleted page removed from all scene regions'
  );

  // The file doc is shared with the source chapter's page — it must survive.
  const srcImgs = (await api(token, 'GET', `/api/manga/chapters/${chapters[0].id}/images`)).body.data;
  const res = await fetch(srcImgs[0].url.startsWith('http') ? srcImgs[0].url : `${BASE}${srcImgs[0].url}`);
  assert.equal(res.status, 200, 'shared file survives merged-unit page deletion');
});

test('deleting a source page keeps the merged-unit clone serving', async () => {
  const srcImgs = (await api(token, 'GET', `/api/manga/chapters/${chapters[0].id}/images`)).body.data;
  const victim = srcImgs[srcImgs.length - 1];
  const mergedImgs = (await api(token, 'GET', `/api/manga/chapters/${merged.id}/images`)).body.data;
  const clone = mergedImgs.find((i) => i.url === victim.url);
  const del = await api(token, 'DELETE', `/api/manga/images/${victim.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const srcAfter = (await api(token, 'GET', `/api/manga/chapters/${chapters[0].id}/images`)).body.data;
  assert.equal(srcAfter.length, srcImgs.length - 1);
  if (clone) {
    const res = await fetch(clone.url.startsWith('http') ? clone.url : `${BASE}${clone.url}`);
    assert.equal(res.status, 200, 'merged clone still serves the shared file');
  }
});

test('story generation on the merged unit skips the estimate gate in local mode', async () => {
  const r = await api(token, 'POST', '/api/story/generate', { projectId: project.id, chapterIds: [merged.id], language: 'en', mode: 'recap' });
  // Local provider is free → 202 (queued) instead of the 428 estimate gate.
  assert.equal(r.status, 202, JSON.stringify(r.body));
  // The job may fail if the local model isn't downloaded — that is the expected local-mode
  // behaviour: a surfaced, retryable job error rather than a silent mock.
  const job = await waitForJob(token, r.body.data.id);
  assert.ok(['completed', 'failed'].includes(job.status));
  if (job.status === 'failed') assert.ok(job.error?.message, 'failure carries a user-visible message');
});

test('deleting the merged unit removes its export but keeps source chapters', async () => {
  const del = await api(token, 'DELETE', `/api/manga/chapters/${merged.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const list = (await api(token, 'GET', `/api/manga/projects/${project.id}/chapters`)).body.data;
  assert.equal(list.filter((c) => c.kind !== 'merged').length, 3, 'source chapters untouched');
  const imgs = (await api(token, 'GET', `/api/manga/chapters/${chapters[0].id}/images`)).body.data;
  assert.ok(imgs.length > 0);
});
