import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const children = [
  spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', 'scripts/dev-api.ts'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, ['../node_modules/vite/bin/vite.js'], { cwd: fileURLToPath(new URL('../admin/', import.meta.url)), stdio: 'inherit' }),
];
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; for (const child of children) child.kill(); };
for (const child of children) { child.on('error', error => { console.error(error.message); process.exitCode = 1; stop(); }); child.on('exit', code => { if (!stopping) { process.exitCode = code ?? 1; stop(); } }); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
