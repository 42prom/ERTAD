import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function plannedPorts(config, includeApps = false) {
  if (config.name !== 'ertad') throw new Error('Expected isolated Compose project ertad');
  const seen = new Set(), ports = [];
  for (const [service, details] of Object.entries(config.services)) {
    if (details.profiles?.length && !(includeApps && details.profiles.includes('apps'))) continue;
    for (const binding of details.ports ?? []) {
      if (binding.host_ip !== '127.0.0.1') throw new Error(`${service} must bind loopback only`);
      const port = Number(binding.published);
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || seen.has(port)) throw new Error(`Invalid or duplicate port ${port}`);
      seen.add(port); ports.push({ service, port });
    }
  }
  return ports;
}

export function assertPortAvailable(port, name = 'Service') {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`${name}: port ${port} is already in use or unavailable. Stop the previous ERTAD dev terminal with Ctrl+C before starting another copy; do not stop unrelated applications.`)));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(resolve));
  });
}

export function ownsRunningPort(containers, service, port) {
  let runningOwn = false;
  for (const container of containers) {
    const own = container.Config.Labels?.['com.docker.compose.project'] === 'ertad' && container.Config.Labels?.['com.docker.compose.service'] === service;
    for (const mappings of Object.values(container.HostConfig.PortBindings ?? {})) {
      for (const mapping of mappings ?? []) {
        if (Number(mapping.HostPort) !== port) continue;
        if (!own) throw new Error(`Port ${port} reserved by ${container.Name}; choose another ERTAD port instead of stopping that project.`);
        runningOwn ||= container.State.Running;
      }
    }
  }
  return runningOwn;
}

function docker(args, failure) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }); }
  catch { throw new Error(failure); } // Compose output may contain credentials; do not dump child-process errors.
}

async function main() {
  process.chdir(fileURLToPath(new URL('../', import.meta.url)));
  try { loadEnvFile('.env'); } catch { throw new Error('Missing .env. Run npm run setup first.'); }
  docker(['info', '--format', '{{.ServerVersion}}'], 'Docker Engine is not ready. Open Docker Desktop, wait for Engine running, then retry npm run infra:up.');
  const includeApps = process.argv.includes('--apps');
  const config = JSON.parse(docker(['compose', '--profile', 'apps', 'config', '--format', 'json'], 'ERTAD Compose configuration is invalid. Check .env and run docker compose config --quiet.'));
  const ids = docker(['ps', '-aq'], 'Cannot list Docker containers. Check Docker Desktop.').trim().split(/\s+/).filter(Boolean);
  const containers = ids.length ? JSON.parse(docker(['inspect', ...ids], 'Cannot inspect Docker port reservations. Retry after Docker finishes starting.')) : [];
  for (const {service, port} of plannedPorts(config, includeApps)) {
    const runningOwn = ownsRunningPort(containers, service, port);
    if (!runningOwn) await assertPortAvailable(port, service);
    console.log(`${service}: 127.0.0.1:${port} ${runningOwn ? '(ERTAD running)' : '(available)'}`);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[preflight] ${error.message}`); process.exitCode = 1; });
}
