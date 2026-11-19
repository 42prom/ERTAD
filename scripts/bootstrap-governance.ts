import { loadEnvFile } from 'node:process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import type { BootstrapPlan } from '../backend/src/modules/governance/bootstrap.ts';

// Explicit offline installer. Never change .env, generate accounts or print tokens.
loadEnvFile('.env');
process.env.NODE_ENV ??= 'development';
const [action, value, ...extra] = process.argv.slice(2);
if (!['development', 'test'].includes(process.env.NODE_ENV) || process.env.ERTAD_BOOTSTRAP_MODE !== 'true'
  || extra.length || !value || !['arm', 'propose', 'confirm', 'reject'].includes(action ?? '')) {
  throw new Error('Explicit development bootstrap mode and a valid installer command are required');
}
const port = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !process.env.POSTGRES_PASSWORD) throw new Error('Local database configuration unavailable');
const owner = new pg.Pool({ host: '127.0.0.1', port, database: 'ertad', user: 'ertad_owner',
  password: process.env.POSTGRES_PASSWORD, options: '-c search_path=ertad,public',
  max: 1, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
// The retained audit writer imports the API pool, but all installer writes use the
// explicit owner transaction. Never connect that otherwise unused pool to production.
process.env.DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/ertad_bootstrap_unused';
const { GovernanceBootstrap } = await import('../backend/src/modules/governance/bootstrap.ts');
const { close } = await import('../backend/src/db/client.ts');
try {
  const service = new GovernanceBootstrap(owner);
  let result;
  if (action === 'arm') {
    const directory = await realpath('.local');
    const file = await realpath(value);
    const relative = path.relative(directory, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || path.extname(file) !== '.json') throw new Error('Ignored local JSON plan required');
    const raw = await readFile(file, 'utf8');
    if (raw.length > 4096) throw new Error('Plan too large');
    const plan = JSON.parse(raw) as BootstrapPlan;
    if (Object.keys(plan).some(key => !['id', 'proposerAccountId', 'confirmerAccountId', 'organizationName', 'reason'].includes(key))) {
      throw new Error('Unexpected plan fields');
    }
    result = await service.arm(plan);
  } else {
    // Read the opaque browser session token through stdin; no command-line secret.
    let token = '';
    for await (const chunk of process.stdin) {
      token += chunk.toString();
      if (token.length > 256) throw new Error('Invalid session input');
    }
    result = action === 'propose' ? await service.propose(value, token.trim())
      : await service.decide(value, token.trim(), action as 'confirm' | 'reject');
  }
  console.log(JSON.stringify(result));
} catch {
  console.error('Governance bootstrap did not complete. Verify eligibility, nominated accounts, fresh password step-up and the ceremony deadline.');
  process.exitCode = 1;
} finally { await owner.end(); await close(); }
