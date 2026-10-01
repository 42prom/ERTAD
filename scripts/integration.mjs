import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadEnvFile } from 'node:process';
import { S3Client, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
loadEnvFile('.env');
const require = createRequire(new URL('../backend/package.json', import.meta.url));
const { Client } = require('pg');
const { createClient } = require('redis');
const pg = new Client({ host: '127.0.0.1', port: Number(process.env.ERTAD_POSTGRES_PORT), database: 'ertad', user: 'ertad_app', password: process.env.APP_DB_PASSWORD, connectionTimeoutMillis: 3000 });
await pg.connect();
try {
  const role = (await pg.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.ok(Object.values(role).every(value => value === false));
  await assert.rejects(pg.query('CREATE TABLE ertad.forbidden_probe(id int)'), error => error.code === '42501');
  await assert.rejects(pg.query('SET ROLE ertad_owner'), error => error.code === '42501');
  const versions = await pg.query('SELECT version FROM ertad.schema_migrations');
  assert.equal(versions.rowCount, 1);
  console.log('PASS restricted DB role, owner separation, applied migration');
} finally { await pg.end(); }
const redis = createClient({ url: `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD)}@127.0.0.1:${process.env.ERTAD_REDIS_PORT}`, socket: { reconnectStrategy: false, connectTimeout: 3000 } });
redis.on('error', () => {});
await redis.connect();
try { assert.equal(await redis.ping(), 'PONG'); console.log('PASS authenticated Redis'); } finally { redis.destroy(); }
const unauthorized = createClient({ url: `redis://127.0.0.1:${process.env.ERTAD_REDIS_PORT}`, socket: { reconnectStrategy: false, connectTimeout: 3000 } });
unauthorized.on('error', () => {});
try { await assert.rejects(async () => { await unauthorized.connect(); await unauthorized.ping(); }, /NOAUTH|Authentication/); console.log('PASS Redis rejects anonymous access'); }
finally { if (unauthorized.isOpen) unauthorized.destroy(); }
const endpoint = `http://127.0.0.1:${process.env.ERTAD_STORAGE_PORT}`;
const s3 = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY } });
const Bucket = 'ertad-attachments';
const Key = `foundation-probes/${randomUUID()}.txt`;
let written = false;
try {
  await s3.send(new HeadBucketCommand({ Bucket }));
  await s3.send(new PutObjectCommand({ Bucket, Key, Body: 'ERTAD synthetic infrastructure probe', ContentType: 'text/plain' }));
  written = true;
  const result = await s3.send(new GetObjectCommand({ Bucket, Key }));
  assert.equal(await result.Body.transformToString(), 'ERTAD synthetic infrastructure probe');
  assert.equal((await fetch(`${endpoint}/${Bucket}/${Key}`)).status, 403);
  console.log('PASS S3 authenticated object roundtrip and anonymous object denial');
} finally { if (written) await s3.send(new DeleteObjectCommand({ Bucket, Key })); s3.destroy(); }
