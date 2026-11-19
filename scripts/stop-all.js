#!/usr/bin/env node
// Counterpart to dev-all: stop everything.
//   npm run stop:all                  -> local processes (api/ai/ui) + docker compose down
//   npm run stop:all -- --keep-docker -> only the local processes; containers stay up
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const keepDocker = process.argv.includes('--keep-docker');
const isWin = process.platform === 'win32';

// api :3000, ai-service :8001 (+stale :8003 orphans), vite :5173
const PORTS = [3000, 8001, 8003, 5173];

const pidsForPort = (port) => {
  if (isWin) {
    try {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      return [...new Set(out.split(/\r?\n/)
        .filter((l) => l.includes('LISTENING') && new RegExp(`:${port}\\s`).test(l))
        .map((l) => l.trim().split(/\s+/).pop()))];
    } catch { return []; }
  }
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return out.split(/\r?\n/).filter(Boolean);
  } catch { return []; }
};

const killed = new Set();
for (const port of PORTS) {
  for (const pid of pidsForPort(port)) {
    if (killed.has(pid)) continue;
    killed.add(pid);
    try {
      if (isWin) execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
      else process.kill(Number(pid), 'SIGTERM');
      console.log(`killed PID ${pid} (port ${port})`);
    } catch { /* already gone */ }
  }
}
if (!killed.size) console.log('no local listeners found on :3000/:8001/:8003/:5173');

if (keepDocker) {
  console.log('docker containers left running (--keep-docker)');
} else {
  const r = spawnSync('docker', ['compose', 'down'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) console.log('docker compose down failed — is Docker Desktop running?');
}
