export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.NODE_ENV ?? 'development';
  if (!['development', 'test'].includes(mode)) {
    throw new Error('Foundation is development-only; production security gates are not implemented.');
  }
  // Bootstrap belongs to the offline installer; never activate it on the API host.
  for (const flag of ['BYPASS_ADMIN_AUTH', 'ALLOW_MOCK_LOGIN', 'DEV_AUTH_BYPASS', 'ERTAD_BOOTSTRAP_MODE']) {
    if (env[flag] && env[flag] !== 'false') throw new Error(`${flag} is forbidden`);
  }
  const port = Number(env.PORT ?? 13000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  for (const name of ['DATABASE_URL', 'REDIS_URL', 'STORAGE_HEALTH_URL', 'WEB_ORIGIN']) {
    if (!env[name]) throw new Error(`${name} is required`);
  }
  const origin = new URL(env.WEB_ORIGIN!);
  if (env.ERTAD_NETWORK_CONTROL === 'true' && (env.ERTAD_LOCAL_ADMIN !== 'true' || !env.ERTAD_PROXY_SECRET || env.ERTAD_PROXY_SECRET.length < 32 || !env.ERTAD_NETWORK_IP_KEY || env.ERTAD_NETWORK_IP_KEY.length < 32)) throw new Error('Network control requires local administration and independent private keys');
  if (env.ERTAD_WEB_DEMO === 'true' && env.ERTAD_LOCAL_ADMIN !== 'true') throw new Error('Web demo requires local administrator mode');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== env.WEB_ORIGIN) {
    throw new Error('WEB_ORIGIN must be an exact HTTP origin');
  }
  if (env.ERTAD_LOCAL_ADMIN === 'true') {
    if (!['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error('Local admin requires a loopback web origin');
    if (!['127.0.0.1', 'localhost', '::1'].includes(env.HOST ?? '127.0.0.1')) throw new Error('Local admin requires a loopback API listener');
    if (!env.API_KEY_ENCRYPTION_SECRET || env.API_KEY_ENCRYPTION_SECRET.length < 32) throw new Error('Local admin encryption key is required');
  }
  return {
    port, host: env.HOST ?? '127.0.0.1', databaseUrl: env.DATABASE_URL!, redisUrl: env.REDIS_URL!,
    storageHealthUrl: env.STORAGE_HEALTH_URL!, webOrigin: origin.origin,
  };
}
