import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const MOBILE_DIR = path.join(ROOT_DIR, 'mobile');
const LOCALHOST_NAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '10.0.2.2',
  '0.0.0.0',
]);

function normalizeApiUrl(rawValue, { requireHttps, rejectLoopback, appendApiV1IfRoot }) {
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) {
    throw new Error('Missing API URL.');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${trimmed}`);
  }
  if (requireHttps && parsed.protocol !== 'https:') {
    throw new Error(`HTTPS is required for remote/release builds (got ${parsed.protocol}).`);
  }
  if (rejectLoopback && LOCALHOST_NAMES.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Loopback/emulator host is not allowed for release builds: ${parsed.hostname}`);
  }
  const cleanUrl = parsed.toString().replace(/\/+$/, '');
  if (appendApiV1IfRoot && (parsed.pathname === '/' || parsed.pathname === '')) {
    return `${cleanUrl}/api/v1`;
  }
  return cleanUrl;
}

function readOptionValue(argv, flag) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === flag && i + 1 < argv.length) {
      return argv[i + 1];
    }
    if (token.startsWith(`${flag}=`)) {
      return token.slice(flag.length + 1);
    }
  }
  return '';
}

/**
 * Resolves the safe `flutter build` invocation arguments for `--tunnel`, `--local`, or `--release`.
 */
export function resolveMobileBuildArgs(argv, env = process.env) {
  const hasTunnel = argv.includes('--tunnel');
  const hasLocal = argv.includes('--local');
  const hasRelease = argv.includes('--release');
  const selectedModes = [hasTunnel, hasLocal, hasRelease].filter(Boolean).length;

  if (selectedModes !== 1) {
    throw new Error(
      'Specify exactly one build mode: --tunnel, --local, or --release --api-url=https://<host>/api/v1'
    );
  }

  if (hasTunnel) {
    const rawOrigin = String(env.ERTAD_TUNNEL_ORIGIN ?? '').trim();
    if (!rawOrigin) {
      throw new Error(
        'Missing ERTAD_TUNNEL_ORIGIN in environment/.env. Configure Cloudflare Tunnel first or use --local.'
      );
    }
    const parsedOrigin = new URL(
      normalizeApiUrl(rawOrigin, {
        requireHttps: true,
        rejectLoopback: true,
        appendApiV1IfRoot: false,
      })
    );
    const apiBaseUrl = `${parsedOrigin.origin}/api/v1`;
    return {
      mode: 'tunnel',
      apiBaseUrl,
      args: [
        'build',
        'apk',
        '--debug',
        '--dart-define=ERTAD_DEV_WORKSPACE=true',
        `--dart-define=API_BASE_URL=${apiBaseUrl}`,
      ],
    };
  }

  if (hasLocal) {
    const port = Number(env.ERTAD_API_PORT ?? '13000');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`Invalid ERTAD_API_PORT: ${env.ERTAD_API_PORT}`);
    }
    const apiBaseUrl = `http://127.0.0.1:${port}/api/v1`;
    return {
      mode: 'local',
      apiBaseUrl,
      args: [
        'build',
        'apk',
        '--debug',
        '--dart-define=ERTAD_DEV_WORKSPACE=true',
        `--dart-define=API_BASE_URL=${apiBaseUrl}`,
      ],
    };
  }

  const rawReleaseUrl = readOptionValue(argv, '--api-url');
  if (!rawReleaseUrl) {
    throw new Error('Release builds require --api-url=https://<production-host>/api/v1');
  }
  const apiBaseUrl = normalizeApiUrl(rawReleaseUrl, {
    requireHttps: true,
    rejectLoopback: true,
    appendApiV1IfRoot: true,
  });
  return {
    mode: 'release',
    apiBaseUrl,
    args: [
      'build',
      'appbundle',
      '--release',
      '--dart-define=FLAVOR=prod',
      `--dart-define=API_BASE_URL=${apiBaseUrl}`,
    ],
  };
}

function main() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // Ignore if already loaded or unreadable; resolveMobileBuildArgs validates required keys.
    }
  }

  const spec = resolveMobileBuildArgs(process.argv.slice(2), process.env);
  console.log(`[mobile-build] mode=${spec.mode} API_BASE_URL=${spec.apiBaseUrl}`);

  const res =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'flutter', ...spec.args], {
          cwd: MOBILE_DIR,
          stdio: 'inherit',
          windowsHide: true,
        })
      : spawnSync('flutter', spec.args, {
          cwd: MOBILE_DIR,
          stdio: 'inherit',
        });

  if (res.error) {
    throw res.error;
  }
  if ((res.status ?? 1) !== 0) {
    process.exit(res.status ?? 1);
  }
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  main();
}
