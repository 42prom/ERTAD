import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
if (!existsSync('.env')) {
  let content = readFileSync('.env.example', 'utf8');
  for (const key of ['POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'REDIS_PASSWORD', 'S3_SECRET_KEY']) {
    content = content.replace(new RegExp(`^${key}=$`, 'm'), `${key}=${randomBytes(32).toString('hex')}`);
  }
  writeFileSync('.env', content, { mode: 0o600, flag: 'wx' });
  console.log('Created local .env with independent random credentials.');
} else { console.log('Existing .env preserved.'); }
try {
  execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/').replace(/\/$/, '')}`, 'config', '--local', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'pipe' });
  console.log('Installed repository-local Git hooks.');
} catch { console.log('Git hook setup pending: run git config --local core.hooksPath .githooks as repository owner.'); }
