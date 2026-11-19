#!/usr/bin/env node
// Runs/installs the Python ai-service inside ai-service/.venv (cross-platform).
//   node scripts/ai-service.js          -> start uvicorn (port from LOCAL_TTS_URL, default :8001)
//   node scripts/ai-service.js install  -> create venv + pip install -r requirements.txt
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// Load repo env so STORY_LLM_* / LOCAL_* settings reach the Python process.
require('dotenv').config({ path: path.join(root, `.env.${process.env.NODE_ENV || 'development'}`) });
require('dotenv').config({ path: path.join(root, '.env') });
const svcDir = path.join(root, 'ai-service');
const venvDir = path.join(svcDir, '.venv');
const venvPython = path.join(venvDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const sysPython = process.platform === 'win32' ? 'python' : 'python3';

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: svcDir });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (process.argv[2] === 'install') {
  if (!fs.existsSync(venvPython)) run(sysPython, ['-m', 'venv', '.venv']);
  run(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt']);
  process.exit(0);
}

if (!fs.existsSync(venvPython)) {
  console.error('ai-service venv missing — run: npm run ai-service:install');
  process.exit(1);
}
// Port must match what the Node backend calls (LOCAL_TTS_URL / PANEL_DETECT_URL) —
// derive it from LOCAL_TTS_URL so the two can't drift; explicit overrides win.
const svcPort = process.env.AI_SERVICE_PORT || process.env.LOCAL_TTS_PORT
  || (() => { try { return new URL(process.env.LOCAL_TTS_URL || '').port; } catch { return ''; } })()
  || '8001';
run(venvPython, [
  '-m', 'uvicorn', 'app:app',
  '--host', process.env.AI_SERVICE_HOST || '127.0.0.1',
  '--port', svcPort,
  ...(process.argv.includes('--reload') ? ['--reload'] : []),
]);
