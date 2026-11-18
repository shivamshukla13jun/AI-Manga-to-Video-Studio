/** Shared helpers for end-to-end API tests against a running server. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const TOKEN_CACHE = path.resolve('tmp/e2e-token.json');

const api = async (token, method, url, body, headers = {}) => {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof Buffer) && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body instanceof Buffer || body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
};

/** Register (idempotent) + login once; the token is cached to respect the login rate limit. */
const login = async () => {
  if (fs.existsSync(TOKEN_CACHE)) {
    const { token } = JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8'));
    const me = await api(token, 'GET', '/api/auth/current-user');
    if (me.status === 200) return token;
  }
  const email = 'e2e-studio@example.com';
  const password = 'E2e-Studio-Pass-123';
  await api(null, 'POST', '/api/auth/register', { name: 'E2E Tester', email, password, confirmPassword: password });
  const r = await api(null, 'POST', '/api/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
  fs.mkdirSync(path.dirname(TOKEN_CACHE), { recursive: true });
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify({ token: r.body.data.accessToken }));
  return r.body.data.accessToken;
};

/** Upload a file through the resumable chunk API, optionally skipping chunks to simulate interruption. */
const uploadCbz = async (token, projectId, filePath, extra = {}, { interruptAfter } = {}) => {
  const data = fs.readFileSync(filePath);
  const fingerprint = `${path.basename(filePath)}:${data.length}:${crypto.createHash('md5').update(data).digest('hex')}`;
  const start = await api(token, 'POST', `/api/manga/projects/${projectId}/uploads`, {
    fileName: path.basename(filePath), size: data.length, fingerprint, ...extra,
  });
  if (start.status >= 300) return { start };
  const s = start.body.data;
  for (let i = 0; i < s.totalChunks; i++) {
    if (s.received.includes(i)) continue;
    if (interruptAfter !== undefined && i >= interruptAfter) return { start, interrupted: true };
    const chunk = data.subarray(i * s.chunkSize, Math.min(data.length, (i + 1) * s.chunkSize));
    const r = await api(token, 'PUT', `/api/manga/uploads/${s.id}/chunks/${i}`, chunk, { 'Content-Type': 'application/octet-stream' });
    if (r.status !== 200) throw new Error(`chunk ${i} failed: ${JSON.stringify(r.body)}`);
  }
  const complete = await api(token, 'POST', `/api/manga/uploads/${s.id}/complete`, extra.allowDuplicate ? { allowDuplicate: true } : {});
  return { start, complete };
};

const waitForJob = async (token, jobId, timeoutMs = 120000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await api(token, 'GET', `/api/jobs/${jobId}`);
    if (['completed', 'failed', 'cancelled'].includes(r.body.data?.status)) return r.body.data;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`job ${jobId} timed out`);
};

module.exports = { BASE, api, login, uploadCbz, waitForJob };
