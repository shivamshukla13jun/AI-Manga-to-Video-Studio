/**
 * Video Studio timeline end-to-end: auto-build from scenes + narration audio,
 * clip split/merge/delete, timeline save with revision checks, versions.
 *
 * Requires the same services as story.e2e.test.js (mock Gemini on :3999).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { api, login, uploadCbz, waitForJob } = require('./helpers');

const FIX = path.resolve('tmp/fixtures');
let token;
let project;
let chapter;
let segments = [];
let video;

test.before(async () => {
  token = await login();
  const r = await api(token, 'POST', '/api/manga/projects', { title: `Video Studio ${Date.now()}`, language: 'ko', narrationLanguage: 'hi' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  project = r.body.data;
  const { complete } = await uploadCbz(token, project.id, path.join(FIX, 'chapter_001.cbz'), { chapterTitle: 'The Beginning' });
  assert.ok(complete.status < 300, JSON.stringify(complete.body));
  chapter = complete.body.data.chapter;
  const done = await waitForJob(token, complete.body.data.job.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));

  // scenes
  const sEst = await api(token, 'POST', '/api/story/estimate/scenes', { projectId: project.id, chapterIds: [chapter.id] });
  assert.equal(sEst.status, 201);
  const detect = await api(token, 'POST', '/api/story/detect', { projectId: project.id, chapterIds: [chapter.id], estimateId: sEst.body.data.id });
  assert.ok(detect.status < 300, JSON.stringify(detect.body));
  const dJob = await waitForJob(token, detect.body.data[0].id);
  assert.equal(dJob.status, 'completed', JSON.stringify(dJob.error));

  // story
  const tEst = await api(token, 'POST', '/api/story/estimate/story', { projectId: project.id, chapterIds: [chapter.id], language: 'hi', mode: 'recap' });
  const gen = await api(token, 'POST', '/api/story/generate', { projectId: project.id, chapterIds: [chapter.id], language: 'hi', mode: 'recap', estimateId: tEst.body.data.id });
  const gJob = await waitForJob(token, gen.body.data.id);
  assert.equal(gJob.status, 'completed', JSON.stringify(gJob.error));
  const segs = await api(token, 'GET', `/api/story/projects/${project.id}/segments?language=hi&mode=recap`);
  segments = segs.body.data;
  assert.ok(segments.length >= 1);

  // narration audio for all segments
  const vEst = await api(token, 'POST', '/api/voice/estimate', { projectId: project.id, segmentIds: segments.map((s) => s.id), provider: 'gemini', voiceId: 'Charon', speed: 1 });
  assert.equal(vEst.status, 201, JSON.stringify(vEst.body));
  const gen2 = await api(token, 'POST', '/api/voice/generate', { projectId: project.id, segmentIds: segments.map((s) => s.id), provider: 'gemini', voiceId: 'Charon', speed: 1, estimateId: vEst.body.data.id });
  assert.ok(gen2.status < 300, JSON.stringify(gen2.body));
  const job = await waitForJob(token, gen2.body.data.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
});

test('auto-build creates tracks timed to narration', async () => {
  const r = await api(token, 'POST', '/api/video/projects', { mangaProjectId: project.id, name: 'Main Edit', language: 'hi', mode: 'recap' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  video = r.body.data;
  const kinds = video.tracks.map((t) => t.kind);
  assert.ok(kinds.includes('background') && kinds.includes('image') && kinds.includes('narration') && kinds.includes('subtitle'));
  const imageTrack = video.tracks.find((t) => t.kind === 'image');
  const narrTrack = video.tracks.find((t) => t.kind === 'narration');
  assert.ok(imageTrack.clips.length >= 1, 'image clips built');
  assert.ok(narrTrack.clips.length >= 1, 'narration clips built');
  assert.ok(imageTrack.clips.every((c) => c.media?.imageUrl), 'image clips resolve signed urls');
  assert.ok(narrTrack.clips.every((c) => c.media?.audioUrl), 'audio clips resolve signed urls');
  assert.ok(video.estimatedDuration > 0);
});

test('clip split produces two adjacent clips with mediaStart offset', async () => {
  const track = video.tracks.find((t) => t.kind === 'narration');
  const clip = track.clips[0];
  const at = clip.start + clip.duration / 2;
  const r = await api(token, 'POST', `/api/video/projects/${video.id}/tracks/${track.id}/clips/${clip.id}/split`, { at });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  video = r.body.data;
  const t2 = video.tracks.find((t) => t.id === track.id);
  const parts = t2.clips.filter((c) => c.name === clip.name);
  assert.equal(parts.length, 2);
  assert.ok(Math.abs(parts[1].mediaStart - (clip.mediaStart + clip.duration / 2)) < 0.01);
});

test('adjacent clips merge back into one', async () => {
  const track = video.tracks.find((t) => t.kind === 'narration');
  const sorted = [...track.clips].sort((a, b) => a.start - b.start);
  const r = await api(token, 'POST', `/api/video/projects/${video.id}/clips/merge`, { trackId: track.id, ids: [sorted[0].id, sorted[1].id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  video = r.body.data;
  const t2 = video.tracks.find((t) => t.id === track.id);
  assert.equal(t2.clips.length, track.clips.length - 1);
});

test('clip update mutates timing; revision increments', async () => {
  const track = video.tracks.find((t) => t.kind === 'image');
  const clip = track.clips[0];
  const r = await api(token, 'PUT', `/api/video/projects/${video.id}/tracks/${track.id}/clips/${clip.id}`, {
    duration: clip.duration + 1.5,
    animation: { type: 'pan-left', keyframes: [] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const updated = r.body.data.tracks.find((t) => t.id === track.id).clips.find((c) => c.id === clip.id);
  assert.equal(updated.animation.type, 'pan-left');
  assert.ok(r.body.data.revision > video.revision);
  video = r.body.data;
});

test('timeline save enforces optimistic concurrency', async () => {
  const tracks = video.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, media: undefined })) }));
  const stale = await api(token, 'PUT', `/api/video/projects/${video.id}/timeline`, { baseRevision: 0, tracks });
  assert.equal(stale.status, 409);
  const ok2 = await api(token, 'PUT', `/api/video/projects/${video.id}/timeline`, { baseRevision: video.revision, tracks, label: 'autosave' });
  assert.equal(ok2.status, 200, JSON.stringify(ok2.body));
  video = ok2.body.data;
});

test('versions snapshot and restore the timeline', async () => {
  const before = video.tracks.find((t) => t.kind === 'image').clips.length;
  const del = await api(token, 'DELETE', `/api/video/projects/${video.id}/tracks/${video.tracks.find((t) => t.kind === 'image').id}/clips/${video.tracks.find((t) => t.kind === 'image').clips[0].id}`);
  assert.equal(del.status, 200);
  video = del.body.data;
  assert.equal(video.tracks.find((t) => t.kind === 'image').clips.length, before - 1);

  const idx = video.versions.find((v) => v.label === 'autosave').index;
  const res = await api(token, 'POST', `/api/video/projects/${video.id}/restore`, { index: idx });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  video = res.body.data;
  assert.equal(video.tracks.find((t) => t.kind === 'image').clips.length, before);
});

test('image clips expose broken-source flag for recovery UI', async () => {
  const track = video.tracks.find((t) => t.kind === 'image');
  assert.ok(track.clips.every((c) => c.media && typeof c.media.broken === 'boolean'));
});

test('render produces a playable mp4 via Remotion+ffmpeg', { timeout: 300000 }, async () => {
  const r = await api(token, 'POST', `/api/video/projects/${video.id}/render`);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const job = await waitForJob(token, r.body.data.job.id, 300000);
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  const v = await api(token, 'GET', `/api/video/projects/${video.id}`);
  assert.equal(v.body.data.renderStatus, 'done');
  assert.ok(v.body.data.outputUrl, 'output url present');
  const dl = await fetch(v.body.data.outputUrl);
  assert.equal(dl.status, 200);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.ok(buf.length > 10000, 'mp4 has content');
  // duplicate render requests are rejected while one is finished? — no, re-render allowed; check mp4 signature
  assert.equal(buf.subarray(4, 8).toString(), 'ftyp');
});
