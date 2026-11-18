/**
 * CBZ → PDF converter end-to-end: upload 6 chapters, merge chapters 1–5
 * into one PDF with bookmarks + page numbers and verify the real output.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { api, login, uploadCbz, waitForJob } = require('./helpers');

const FIX = path.resolve('tmp/fixtures');
let token;
let project;
let chapters;

test.before(async () => {
  token = await login();
  const r = await api(token, 'POST', '/api/manga/projects', { title: `PDF Test ${Date.now()}` });
  project = r.body.data;
  for (let ch = 1; ch <= 6; ch++) {
    const up = await uploadCbz(token, project.id, path.join(FIX, `chapter_00${ch}.cbz`), { allowDuplicate: true });
    assert.equal(up.complete.status, 201, JSON.stringify(up.complete.body));
  }
  chapters = (await api(token, 'GET', `/api/manga/projects/${project.id}/chapters`)).body.data;
  assert.equal(chapters.length, 6);
});

test('merges chapters 1-5 into one PDF with bookmarks and page numbers', async () => {
  const r = await api(token, 'POST', '/api/pdf/exports', {
    projectId: project.id,
    startNumber: 1,
    endNumber: 5,
    pageNumbers: true,
    bookmarks: true,
  });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.data.fileName, `${project.title} - Chapters 1-5.pdf`);
  assert.equal(r.body.data.chapters.length, 5);
  const job = await waitForJob(token, r.body.data.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.equal(job.result.pageCount, 15, '5 chapters × 3 pages');

  const exp = (await api(token, 'GET', `/api/pdf/exports/${r.body.data.id}`)).body.data;
  assert.equal(exp.status, 'completed');
  const res = await fetch(exp.downloadUrl);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const pdf = Buffer.from(await res.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const text = pdf.toString('latin1');
  assert.equal((text.match(/\/Type \/Page\b/g) || []).length, 15);
  assert.ok(text.includes('/Outlines'), 'has outline (bookmarks)');
  for (let ch = 1; ch <= 5; ch++) assert.ok(text.includes(`(Chapter ${ch}`) || text.includes('Chapter'), `bookmark ${ch}`);
  assert.ok(!text.includes('Chapter 6 '), 'chapter 6 excluded');

  // JPEG pages must be embedded without recompression: original bytes appear verbatim
  const ch1 = chapters.find((c) => c.number === 1);
  const imgs = (await api(token, 'GET', `/api/manga/chapters/${ch1.id}/images`)).body.data;
  const jpg = imgs.find((i) => i.format === 'jpeg');
  const original = Buffer.from(await (await fetch(jpg.url)).arrayBuffer());
  assert.ok(pdf.includes(original.subarray(200, 1200)), 'JPEG embedded byte-for-byte');
});

test('supports an explicit, reordered chapter selection', async () => {
  const pick = [5, 2, 3].map((n) => chapters.find((c) => c.number === n).id);
  const r = await api(token, 'POST', '/api/pdf/exports', { projectId: project.id, chapterIds: pick, compression: 'small' });
  assert.equal(r.status, 202);
  assert.deepEqual(r.body.data.chapters, pick);
  assert.match(r.body.data.fileName, /Chapters 2-3|Chapters 2, 3, 5|Chapters 2-5/);
  const job = await waitForJob(token, r.body.data.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.equal(job.result.pageCount, 9);
});

test('validates selections', async () => {
  const bad = await api(token, 'POST', '/api/pdf/exports', { projectId: project.id, startNumber: 5, endNumber: 1 });
  assert.equal(bad.status, 400);
  const none = await api(token, 'POST', '/api/pdf/exports', { projectId: project.id, startNumber: 50, endNumber: 60 });
  assert.equal(none.status, 400);
});
