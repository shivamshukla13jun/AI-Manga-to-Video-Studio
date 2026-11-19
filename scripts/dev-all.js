#!/usr/bin/env node
// One-command dev stack: docker infra (redis/rabbitmq) + free-gemini-api proxy
// + ai-service (:8001) + API/workers (:3000) + frontend (:5173).
//   npm run dev:all              -> everything
//   npm run dev:all -- --no-ui   -> skip the frontend
//   npm run dev:all -- --no-ai   -> skip the Python ai-service (and the proxy)
// Ctrl+C tears down the three local processes; docker containers stay up.
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const root = path.join(__dirname, '..');
const skipUi = process.argv.includes('--no-ui');
const skipAi = process.argv.includes('--no-ai');
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

const C = { api: 36, ai: 33, ui: 35, infra: 34, reset: 0 };
const say = (tag, msg) => console.log(`\x1b[${C[tag] || 37}m[${tag}]\x1b[0m ${msg}`);

const compose = (dir, extraArgs = []) => {
  const r = spawnSync('docker', ['compose', 'up', '-d', ...extraArgs], { cwd: dir, stdio: 'inherit' });
  return r.status === 0;
};

const waitPort = (port, host = '127.0.0.1', timeoutMs = 90000) => new Promise((resolve, reject) => {
  const deadline = Date.now() + timeoutMs;
  const probe = () => {
    const s = net.connect(port, host);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => {
      s.destroy();
      if (Date.now() > deadline) return reject(new Error(`port ${port} not listening after ${timeoutMs / 1000}s`));
      setTimeout(probe, 1500);
    });
  };
  probe();
});

// Kill a whole process tree (Windows: taskkill /T; POSIX: signal the group).
const killTree = (child) => {
  if (!child || child.killed || !child.pid) return;
  try {
    if (isWin) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch { /* already gone */ }
};

const children = [];
const run = (tag, cmd, args, cwd = root) => {
  say(tag, `${cmd} ${args.join(' ')}`);
  const child = isWin
    ? spawn(`${cmd} ${args.join(' ')}`, { cwd, shell: true, env: process.env })
    : spawn(cmd, args, { cwd, detached: true, env: process.env });
  child.stdout.on('data', (d) => d.toString().split(/\r?\n/).forEach((l) => l && console.log(`\x1b[${C[tag]}m[${tag}]\x1b[0m ${l}`)));
  child.stderr.on('data', (d) => d.toString().split(/\r?\n/).forEach((l) => l && console.log(`\x1b[${C[tag]}m[${tag}!]\x1b[0m ${l}`)));
  child.on('exit', (code) => say(tag, `exited (${code})`));
  children.push(child);
  return child;
};

const shutdown = () => {
  say('infra', 'shutting down local processes (docker containers stay up)...');
  children.forEach(killTree);
  setTimeout(() => process.exit(0), 800);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const proxyDir = path.resolve(root, '..', 'free-gemini-api', 'free-gemini-api');
const hasProxy = fs.existsSync(path.join(proxyDir, 'docker-compose.yml')) && !skipAi;

(async () => {
  say('infra', 'docker compose up -d (redis, rabbitmq' + (hasProxy ? ', free-gemini-api' : '') + ', suwayomi, flaresolverr)');
  if (!compose(root)) { say('infra', 'docker compose failed — is Docker Desktop running?'); process.exit(1); }
  if (!hasProxy && !skipAi) say('infra', `free-gemini-api clone not found at ${proxyDir} — story LLM unavailable`);

  say('infra', 'waiting for redis :6379 + rabbitmq :5672' + (hasProxy ? ' + proxy :8002' : ''));
  try {
    await Promise.all([waitPort(6379), waitPort(5672), ...(hasProxy ? [waitPort(8002)] : [])]);
  } catch (e) { say('infra', e.message); process.exit(1); }
  say('infra', 'infra ready');

  if (!skipAi) run('ai', 'node', ['scripts/ai-service.js']);
  run('api', npmCmd, ['run', 'dev']);
  if (!skipUi) run('ui', npmCmd, ['run', 'dev'], path.join(root, 'frontend'));

  say('infra', 'all launched — Ctrl+C stops local services (docker keeps running)');
})().catch((e) => { say('infra', `fatal: ${e.message}`); shutdown(); });
