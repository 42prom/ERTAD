import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const names = execFileSync('git', ['-c', `safe.directory=${root}`, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const denied = names.filter(name => {
  const path = name.toLowerCase();
  const file = path.split('/').at(-1);
  return /(^|\/)(directives|prompts|flutter-scaffold-skill|\.security-skills|\.agents|\.codex|\.claude|\.work|\.local|\.cache)(\/|$)/.test(path)
    || /^(agents|claude|project_rules|audit_.*|discovery_report|comparative_insights|learnings.*|fix_log|ship_ready_verdict|security_threats|store_compliance|positioning_charter)\.md$/.test(file)
    || (file.endsWith('.md') && file.includes('prompt'))
    || (file === '.env' || (file.startsWith('.env.') && file !== '.env.example'))
    || /\.(pem|key|dump)$/.test(file);
});
if (denied.length) throw new Error(`Local or sensitive files would be published:\n${denied.join('\n')}`);
// Also detect accidental inclusion of this workspace's generated credentials.
const envPath = resolve(root, '.env');
const secrets = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter(line => /^(POSTGRES_PASSWORD|APP_DB_PASSWORD|REDIS_PASSWORD|S3_SECRET_KEY)=/.test(line))
  .map(line => line.slice(line.indexOf('=') + 1)).filter(value => value.length >= 16) : [];
for (const name of names) {
  const path = resolve(root, name);
  if (existsSync(path) && statSync(path).isFile() && statSync(path).size < 2_000_000) {
    const content = readFileSync(path, 'utf8');
    if (secrets.some(secret => content.includes(secret))) throw new Error(`Local credential detected in ${name}`);
  }
}
console.log(`PASS workspace publication guard (${names.length} eligible paths)`);
