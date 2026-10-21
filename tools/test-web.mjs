// Runs the web app on port 5174 against the TEST API (port 4001, database holysai_test), for trying things in the
// browser without touching the schools' real data. Start the test API first: node tools/test-api.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npm, ['run', 'dev', '-w', '@holysai/web', '--', '--port', process.env.TEST_WEB_PORT ?? '5174', '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, API_URL: process.env.TEST_API_URL ?? 'http://localhost:4001' },
});
const stop = () => child.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
