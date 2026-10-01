export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.NODE_ENV ?? 'development';
  if (!['development', 'test'].includes(mode)) {
    throw new Error('Foundation is development-only; production security gates are not implemented.');
  }
  for (const flag of ['BYPASS_ADMIN_AUTH', 'ALLOW_MOCK_LOGIN', 'DEV_AUTH_BYPASS']) {
    if (env[flag] && env[flag] !== 'false') throw new Error(`${flag} is forbidden`);
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  for (const name of ['DATABASE_URL', 'REDIS_URL', 'STORAGE_HEALTH_URL', 'WEB_ORIGIN']) {
    if (!env[name]) throw new Error(`${name} is required`);
  }
  const origin = new URL(env.WEB_ORIGIN!);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== env.WEB_ORIGIN) {
    throw new Error('WEB_ORIGIN must be an exact HTTP origin');
  }
  return {
    port, host: env.HOST ?? '127.0.0.1', databaseUrl: env.DATABASE_URL!, redisUrl: env.REDIS_URL!,
    storageHealthUrl: env.STORAGE_HEALTH_URL!, webOrigin: origin.origin,
  };
}
