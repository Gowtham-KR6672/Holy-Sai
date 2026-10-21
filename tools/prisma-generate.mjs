// Runs `prisma generate` for apps/api (the school client and the We School platform client) under a cross-process
// lock, so parallel builds never regenerate a client at the same time (which corrupts it on Windows).
import { execSync } from 'node:child_process';
import { mkdirSync, rmdirSync, statSync } from 'node:fs';
import path from 'node:path';

const lock = path.resolve('.data/prisma-generate.lock');
mkdirSync(path.dirname(lock), { recursive: true });

const started = Date.now();
for (;;) {
  try {
    mkdirSync(lock);
    break;
  } catch {
    // A lock older than two minutes is stale (a crashed run).
    try {
      if (Date.now() - statSync(lock).mtimeMs > 120_000) rmdirSync(lock);
    } catch {}
    if (Date.now() - started > 300_000) {
      console.error('Timed out waiting for the prisma generate lock');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));
  }
}

let code = 0;
try {
  execSync('npx prisma generate', { cwd: path.resolve('apps/api'), stdio: 'inherit' });
  execSync('npx prisma generate --schema prisma/platform/schema.prisma', { cwd: path.resolve('apps/api'), stdio: 'inherit' });
} catch {
  code = 1;
} finally {
  rmdirSync(lock);
}
process.exit(code);
