// Runs the built API (apps/api/dist) on port 4001 against the TEST database (holysai_test), so tests in tools/tests
// never touch the schools' real data. Build first: npm run build -w @holysai/api
import { spawn } from 'node:child_process';
import path from 'node:path';

const api = path.resolve(import.meta.dirname, '..', 'apps', 'api');
const child = spawn(process.execPath, ['dist/main.js'], {
  cwd: api,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: process.env.TEST_API_PORT ?? '4001',
    // Tests sign in many times a minute.
    LOGIN_RATE_LIMIT: process.env.LOGIN_RATE_LIMIT ?? '500',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://holysai:holysai_dev@localhost:5433/holysai_test',
  },
});
const stop = () => child.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
