import { loadEnvFile } from 'node:process';
loadEnvFile('.env');
process.env.MIGRATION_DATABASE_URL = `postgresql://ertad_owner:${encodeURIComponent(process.env.POSTGRES_PASSWORD ?? '')}@127.0.0.1:${process.env.ERTAD_POSTGRES_PORT ?? '15432'}/ertad`;
await import('../backend/dist/migrate.js');
