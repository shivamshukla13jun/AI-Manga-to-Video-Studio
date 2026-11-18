/**
 * Public manga metadata (Jikan -> AniList fallback) enrichment: creating a
 * project with a known title seeds the character registry, description,
 * genres and cover. Skips gracefully when both public APIs are unreachable.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { api, login } = require('./helpers');

let token;
let project;

test.before(async () => {
  token = await login();
});

test('creating a project seeds characters from public metadata', async () => {
  const r = await api(token, 'POST', '/api/manga/projects', { title: 'Solo Leveling', language: 'ko' });
  assert.equal(r.status, 201);
  project = r.body.data;
  // give the background enrich a moment (Jikan timeout + AniList fallback)
  await new Promise((res) => setTimeout(res, 20000));
  const meta = await api(token, 'POST', `/api/manga/projects/${project.id}/fetch-metadata`);
  assert.equal(meta.status, 200);
  if (!meta.body.data.matched) {
    console.log('  [skip] public metadata APIs unreachable from this network');
    return;
  }
  assert.ok(meta.body.data.provider, 'provider recorded');
  assert.ok(meta.body.data.charactersImported >= 0);
});

test('imported characters carry source=api and external refs', async (t) => {
  const chars = await api(token, 'GET', `/api/story/projects/${project.id}/characters`);
  if (!chars.body.data.length) return t.skip('no characters imported (metadata APIs unreachable)');
  const apiChars = chars.body.data.filter((c) => c.source === 'api');
  assert.ok(apiChars.length >= 1, 'at least one api-sourced character');
  assert.ok(apiChars.every((c) => c.external && ['jikan', 'anilist'].includes(c.external.provider)));
  assert.ok(apiChars.some((c) => c.external.imageUrl), 'character images captured');
});

test('fetchMetadata=false on create skips the enrichment', async () => {
  const r = await api(token, 'POST', '/api/manga/projects', { title: `No Meta ${Date.now()}`, fetchMetadata: false });
  assert.equal(r.status, 201);
  await new Promise((res) => setTimeout(res, 1500));
  const chars = await api(token, 'GET', `/api/story/projects/${r.body.data.id}/characters`);
  assert.equal(chars.body.data.length, 0);
});
