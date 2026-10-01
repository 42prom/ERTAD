import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
try { loadEnvFile('.env'); } catch { throw new Error('Run npm run setup first.'); }
const config = JSON.parse(execFileSync('docker', ['compose', '--profile', 'apps', 'config', '--format', 'json'], { encoding: 'utf8' }));
if (config.name !== 'ertad') throw new Error('Expected isolated Compose project ertad');
// Account for stopped containers too; they may be started later by another project.
const ids = execFileSync('docker', ['ps', '-aq'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
const containers = ids.length ? JSON.parse(execFileSync('docker', ['inspect', ...ids], { encoding: 'utf8' })) : [];
const seen = new Set();
for (const [service, details] of Object.entries(config.services)) {
  for (const binding of details.ports ?? []) {
    if (binding.host_ip !== '127.0.0.1') throw new Error(`${service} must bind loopback only`);
    const port = Number(binding.published);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || seen.has(port)) throw new Error(`Invalid or duplicate port ${port}`);
    seen.add(port);
    let runningOwn = false;
    for (const container of containers) {
      const own = container.Config.Labels?.['com.docker.compose.project'] === config.name && container.Config.Labels?.['com.docker.compose.service'] === service;
      for (const mappings of Object.values(container.HostConfig.PortBindings ?? {})) {
        for (const mapping of mappings ?? []) {
          if (Number(mapping.HostPort) !== port) continue;
          if (!own) throw new Error(`Port ${port} reserved by ${container.Name}`);
          runningOwn ||= container.State.Running;
        }
      }
    }
    if (!runningOwn) {
      await new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', () => reject(new Error(`Port ${port} unavailable on host`)));
        server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(resolve));
      });
    }
    console.log(`${service}: 127.0.0.1:${port} ${runningOwn ? '(ERTAD running)' : '(available)'}`);
  }
}
