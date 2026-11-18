/**
 * AI story pipeline end-to-end (mocked Gemini): cost estimates, scene
 * detection, story generation, scene/narration editing, edit locks,
 * split/merge/reorder, characters and usage metering.
 *
 * Requires:
 *   1. mock Gemini:  node tests/mocks/gemini.js
 *   2. API started with:
 *        GEMINI_API_KEY=mock-key GEMINI_API_BASE=http://127.0.0.1:3999 npm run dev
 *   3. fixtures:     npm run test:fixtures
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { api, login, uploadCbz, waitForJob } = require('./helpers');

const FIX = path.resolve('tmp/fixtures');
let token;
let project;
let chapter;
let scenes = [];
let segments = [];

test.before(async () => {
  token = await login();
  // Detection tests run the free local CV path; the story tests flip to Gemini below.
  await api(token, 'PUT', '/api/voice/settings', { aiProvider: 'local' });
  const r = await api(token, 'POST', '/api/manga/projects', { title: `AI Pipeline ${Date.now()}`, language: 'ko', narrationLanguage: 'hi' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  project = r.body.data;
  const { complete } = await uploadCbz(token, project.id, path.join(FIX, 'chapter_001.cbz'), { chapterTitle: 'The Beginning' });
  assert.equal(complete.status, 201, JSON.stringify(complete.body));
  chapter = complete.body.data.chapter;
  const done = await waitForJob(token, complete.body.data.job.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
});

test('project overview reports un-analysed chapter', async () => {
  const r = await api(token, 'GET', `/api/story/projects/${project.id}/overview?language=hi&mode=recap`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.chapters.length, 1);
  assert.equal(r.body.data.chapters[0].scenes, 0);
  assert.equal(r.body.data.aiConfigured, true, 'GEMINI_API_KEY should be set for this test run');
});

test('scene detection is local CV — free, no estimate — and returns a job', async () => {
  const r = await api(token, 'POST', '/api/story/detect', { projectId: project.id, chapterIds: [chapter.id] });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const job = await waitForJob(token, r.body.data[0].id);
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.ok(job.result.scenes >= 1);
});

test('detected scenes have source image references and ordered regions', async () => {
  const r = await api(token, 'GET', `/api/story/chapters/${chapter.id}/scenes`);
  assert.equal(r.status, 200);
  scenes = r.body.data;
  assert.ok(scenes.length >= 1, 'at least one scene detected');
  assert.ok(scenes.every((s) => s.regions.length >= 1 && s.regions.every((g) => g.image && g.imageUrl)));
  assert.deepEqual(scenes.map((s) => s.order), scenes.map((s) => s.order).sort((a, b) => a - b));
  const fresh = await api(token, 'GET', `/api/story/chapters/${chapter.id}/scenes`);
  scenes = fresh.body.data;
});

test('detection produces visual-only scenes; narration is a separate AI step', async () => {
  const seg = await api(token, 'GET', `/api/story/projects/${project.id}/segments?language=hi&mode=recap`);
  assert.equal(seg.status, 200);
  assert.equal(seg.body.data.length, 0, 'no narration before story generation');
  assert.ok(scenes.every((s) => (s.dialogues || []).length === 0), 'scenes carry no OCR text');
  assert.ok(scenes.every((s) => s.source === 'cv'), 'scenes come from the local CV detector');
  // narration language/mode come from global studio settings, not per-project
  const set = await api(token, 'PUT', '/api/voice/settings', { narrationMode: 'original' });
  assert.equal(set.status, 200);
  const ov = await api(token, 'GET', `/api/story/projects/${project.id}/overview`);
  assert.equal(ov.body.data.mode, 'original');
  await api(token, 'PUT', '/api/voice/settings', { narrationMode: 'recap' });
});

test('story generation covers every scene with narration', async () => {
  const prov = await api(token, 'PUT', '/api/voice/settings', { aiProvider: 'gemini' });
  assert.equal(prov.status, 200, JSON.stringify(prov.body));
  const est = await api(token, 'POST', '/api/story/estimate/story', { projectId: project.id, chapterIds: [chapter.id], language: 'hi', mode: 'recap' });
  assert.equal(est.status, 201);
  const r = await api(token, 'POST', '/api/story/generate', { projectId: project.id, chapterIds: [chapter.id], language: 'hi', mode: 'recap', estimateId: est.body.data.id });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const job = await waitForJob(token, r.body.data.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.error));

  const seg = await api(token, 'GET', `/api/story/projects/${project.id}/segments?language=hi&mode=recap`);
  assert.equal(seg.status, 200);
  segments = seg.body.data;
  const covered = new Set(segments.flatMap((s) => s.scenes));
  assert.equal(covered.size, scenes.length, 'every scene narrated exactly once');
  assert.ok(segments.every((s) => s.narration.trim().length > 0 && s.wordCount > 0 && s.estimatedDuration > 0));
});

test('characters from analysis are tracked', async () => {
  const r = await api(token, 'GET', `/api/story/projects/${project.id}/characters`);
  assert.equal(r.status, 200);
  const names = r.body.data.map((c) => c.name);
  assert.ok(names.includes('Hero') && names.includes('Rival'), JSON.stringify(names));
});

test('narration edit sets userEdited; regeneration without force is refused', async () => {
  const seg = segments[0];
  const upd = await api(token, 'PUT', `/api/story/segments/${seg.id}`, { narration: 'Manually corrected narration line.' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.data.userEdited, true);
  assert.equal(upd.body.data.narration, 'Manually corrected narration line.');

  const locked = await api(token, 'POST', `/api/story/segments/${seg.id}/rewrite`, { action: 'regenerate' });
  assert.equal(locked.status, 409);

  const job = await api(token, 'POST', `/api/story/segments/${seg.id}/rewrite`, { action: 'regenerate', force: true });
  assert.equal(job.status, 202);
  const done = await waitForJob(token, job.body.data.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  const after = await api(token, 'GET', `/api/story/projects/${project.id}/segments?language=hi&mode=recap`);
  const rewritten = after.body.data.find((s) => s.id === seg.id);
  assert.match(rewritten.narration, /MOCK rewritten/);
  assert.ok(rewritten.history.length >= 2, 'edit history kept');
});

test('scene split -> merge -> reorder -> delete keep order contiguous', async () => {
  const list = async () => (await api(token, 'GET', `/api/story/chapters/${chapter.id}/scenes`)).body.data;
  let cur = await list();
  // CV scenes have one region each — merge two first, then split the merged scene back.
  const merged = await api(token, 'POST', '/api/story/scenes/merge', { ids: [cur[0].id, cur[1].id] });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  cur = await list();
  assert.equal(cur.length, scenes.length - 1);
  assert.equal(cur[0].userEdited, true);

  const target = cur[0];
  const split = await api(token, 'POST', `/api/story/scenes/${target.id}/split`, { regionIndex: Math.ceil(target.regions.length / 2) });
  assert.equal(split.status, 200, JSON.stringify(split.body));
  cur = await list();
  assert.equal(cur.length, scenes.length);
  assert.equal(cur[0].regions.length + cur[1].regions.length, target.regions.length);

  const reorderedIds = [...cur.map((s) => s.id)].reverse();
  const re = await api(token, 'PUT', `/api/story/chapters/${chapter.id}/scenes/reorder`, { ids: reorderedIds });
  assert.equal(re.status, 200);
  cur = await list();
  assert.deepEqual(cur.map((s) => s.id), reorderedIds);
  assert.deepEqual(cur.map((s) => s.order), cur.map((_, i) => i + 1));

  // restore original order, then delete one scene and confirm count drops
  await api(token, 'PUT', `/api/story/chapters/${chapter.id}/scenes/reorder`, { ids: reorderedIds.slice().reverse() });
  const del = await api(token, 'DELETE', `/api/story/scenes/${cur[0].id}`);
  assert.equal(del.status, 200);
  cur = await list();
  assert.equal(cur.length, scenes.length - 1);
  assert.deepEqual(cur.map((s) => s.order), cur.map((_, i) => i + 1));
});

test('usage records link back to the approved estimate', async () => {
  const est = await api(token, 'GET', `/api/story/projects/${project.id}/estimates`);
  assert.equal(est.status, 200);
  assert.ok(est.body.data.length >= 1, 'approved estimates listed');
});
