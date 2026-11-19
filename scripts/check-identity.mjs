import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

// Only publishable first-party files; dependencies, immutable archives and Git history are excluded.
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))];
const inheritedBrand = new RegExp(['d' + 'tg', 'd' + 'tfg', ['Democracy', 'Tools', 'Of', 'Georgia'].join(' '), 'esme\\.ge'].join('|'), 'i');
const inheritedEndpoint = /(?:https?:\/\/|redis:\/\/)(?:localhost|127\.0\.0\.1|10\.0\.2\.2|backend):(?:3000|5173|8000|8080)\b/;
const violations = [];
for (const file of files) {
  if (!existsSync(file) || !statSync(file).isFile()) continue;
  if (inheritedBrand.test(file)) violations.push(`${file}: inherited path`);
  // Dependency integrity values are opaque hashes, not product identity.
  if (/package-lock\.json$|\.lock$/.test(file)) continue;
  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { continue; }
  if (inheritedBrand.test(text)) violations.push(`${file}: inherited identity`);
  if (inheritedEndpoint.test(text)) violations.push(`${file}: inherited service endpoint`);
}
if (violations.length) throw new Error(violations.join('\n'));
console.log('PASS ERTAD identity and service endpoint guard');
