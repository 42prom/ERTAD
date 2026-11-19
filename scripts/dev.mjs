import { spawn, execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertPortAvailable } from './preflight.mjs';
import {openDevControl,requestDevStop} from './dev-control.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), children = [];
let stopping = false, control, shutdown;
function stop() {
  if (stopping) return shutdown;
  stopping = true;
  if(control?.listening)control.close();
  shutdown=Promise.all(children.map(child=>new Promise(resolve=>{
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {resolve();return;}
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true }, () => resolve());
    else {child.once('exit',resolve);child.kill('SIGTERM');}
  })));
  return shutdown;
}
function launch(name, executable, args, cwd = root) {
  const child = spawn(executable, args, { cwd, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.on('error', error => { console.error(`[dev] ${name} could not start: ${error.message}`); process.exitCode = 1; stop(); });
  child.on('exit', code => {
    if (!stopping) { console.error(`[dev] ${name} stopped (exit ${code ?? 'signal'}).`); process.exitCode = code || 1; stop(); }
  });
}
async function ready(url) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); return response.ok && (await response.json()).status === 'ready'; }
  catch { return false; }
}
async function main() {
  if(process.argv.includes('--stop')) {
    console.log(await requestDevStop(root) ? '[dev] API, web and tunnel stopped. Docker data services are unchanged.' : '[dev] No development runner is active for this ERTAD checkout.');
    return;
  }
  try { process.loadEnvFile(path.join(root, '.env')); }
  catch { throw new Error('Missing .env. Run npm run setup first.'); }
  const apiPort = Number(process.env.ERTAD_API_PORT ?? 13000), webPort = Number(process.env.ERTAD_WEB_PORT ?? 15173);
  if ([apiPort, webPort].some(port => !Number.isInteger(port) || port < 1024 || port > 65535) || apiPort === webPort) throw new Error('ERTAD_API_PORT and ERTAD_WEB_PORT must be distinct valid ports.');
  await assertPortAvailable(apiPort, 'API'); await assertPortAvailable(webPort, 'Web');
  if (process.env.ERTAD_NETWORK_CONTROL === 'true') {
    const ingressPort = Number(process.env.ERTAD_TUNNEL_INGRESS_PORT ?? 15174);
    if (!Number.isInteger(ingressPort) || ingressPort < 1024 || ingressPort > 65535 || [apiPort,webPort].includes(ingressPort)) throw new Error('Invalid tunnel ingress port');
    await assertPortAvailable(ingressPort, 'Tunnel ingress');
  }
  const tunnel = process.env.ERTAD_TUNNEL === 'true', cfgPath = path.join(root, 'infra', 'cloudflared.yml');
  if (tunnel) {
    const origin = new URL(process.env.ERTAD_TUNNEL_ORIGIN ?? '');
    if (origin.protocol !== 'https:' || origin.origin !== process.env.ERTAD_TUNNEL_ORIGIN || origin.host !== process.env.ERTAD_TUNNEL_HOST) throw new Error('Set matching ERTAD_TUNNEL_HOST and HTTPS ERTAD_TUNNEL_ORIGIN in .env.');
    if (!existsSync(cfgPath)) throw new Error('Missing ignored infra/cloudflared.yml. Configure the named tunnel, or set ERTAD_TUNNEL=false for local-only development.');
    try { execFileSync('cloudflared', ['--config', cfgPath, 'tunnel', 'ingress', 'validate'], { stdio: 'pipe', windowsHide: true, timeout: 15000 }); }
    catch { throw new Error('Cloudflare configuration is unavailable/invalid. Check cloudflared and infra/cloudflared.yml, or set ERTAD_TUNNEL=false for local-only development.'); }
  }
  if(stopping)return;
  control=await openDevControl(root,stop);
  if(stopping){control.close();return;}
  launch('API', process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'watch', path.join(root, 'scripts', 'dev-api.ts')]);
  launch('Web', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')], path.join(root, 'admin'));
  console.log('[dev] Waiting for API/web readiness (up to 120 seconds for a cold TypeScript start).');
  const deadline = Date.now() + 120000;
  while (!stopping && Date.now() < deadline) {
    if (await ready(`http://127.0.0.1:${apiPort}/health/ready`) && await ready(`http://127.0.0.1:${webPort}/health/ready`)) {
      if(stopping)return;
      console.log(`[dev] Ready: http://localhost:${webPort}/login (keep this terminal open; Ctrl+C stops API, web and tunnel)`);
      if (tunnel) {
        launch('Cloudflare tunnel', 'cloudflared', ['--config', cfgPath, 'tunnel', 'run']);
        console.log(`[dev] Connecting tunnel: ${process.env.ERTAD_TUNNEL_ORIGIN}`);
      }
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!stopping) throw new Error('API/web did not become ready. Start Docker Desktop, run npm run infra:up, then npm run db:migrate, and retry npm run dev.');
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
main().catch(error => { console.error(`[dev] ${error.message}`); process.exitCode = 1; stop(); });
