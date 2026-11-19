import { randomBytes } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import pg from 'pg';

loadEnvFile('.env');
if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') throw new Error('Local bootstrap only');
process.env.NODE_ENV = 'development';
const port = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local database port');
if (!process.env.POSTGRES_PASSWORD || !process.env.APP_DB_PASSWORD) throw new Error('Run npm run setup first');
const accessPath = '.local/admin-access.json';
const guidePath = '.local/ADMIN_ACCESS.md';
function setEnv(key: string, value: string) {
  const lines = readFileSync('.env', 'utf8').trimEnd().split(/\r?\n/);
  const index = lines.findIndex(line => line.startsWith(`${key}=`));
  if (index < 0) lines.push(`${key}=${value}`); else lines[index] = `${key}=${value}`;
  writeFileSync('.env', lines.join('\n') + '\n');
  process.env[key] = value;
}
if (!process.env.API_KEY_ENCRYPTION_SECRET) setEnv('API_KEY_ENCRYPTION_SECRET', randomBytes(32).toString('base64url'));
if (process.env.API_KEY_ENCRYPTION_SECRET.length < 32) throw new Error('Existing local encryption key is too short');
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD)}@127.0.0.1:${port}/ertad`;
const { hashAdminPassword } = await import('../backend/src/services/adminPassword.ts');
const { SecurityService } = await import('../backend/src/services/security.ts');
const { close } = await import('../backend/src/db/client.ts');
const client = new pg.Client({ host: '127.0.0.1', port, database: 'ertad', user: 'ertad_owner', password: process.env.POSTGRES_PASSWORD, options: '-c search_path=ertad,public' });
await client.connect();
let createdJson = false;
let createdGuide = false;
let committed = false;
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(42420002)');
  const existing = await client.query('SELECT id FROM ertad.admin_users');
  if (existing.rowCount) {
    if (!existsSync(accessPath) || !existsSync(guidePath)) throw new Error('An admin already exists; credentials will not be reset automatically');
    const access = JSON.parse(readFileSync(accessPath, 'utf8'));
    if (!existing.rows.some(row => row.id === access.id)) throw new Error('Local credentials do not match an existing account');
    await client.query('ROLLBACK');
    setEnv('ERTAD_LOCAL_ADMIN', 'true');
    console.log('Existing local administrator preserved. Credentials: .local/ADMIN_ACCESS.md');
  } else {
    if (existsSync(accessPath) || existsSync(guidePath)) throw new Error('Existing local credential files require review; refusing overwrite');
    const email = 'admin@ertad.local';
    const password = randomBytes(24).toString('base64url');
    const passwordHash = await hashAdminPassword(password);
    const inserted = await client.query(
      `INSERT INTO ertad.admin_users (email, password_hash, role, full_name)
       VALUES ($1, $2, 'superadmin', 'ERTAD local administrator') RETURNING id`,
      [email, passwordHash],
    );
    const id = inserted.rows[0].id;
    await SecurityService.logAuditEventInTransaction(client, 'LOCAL_ADMIN_BOOTSTRAPPED', { adminUserId: id });
    const url = `http://localhost:${process.env.ERTAD_WEB_PORT ?? 15173}/login`;
    const access = { id, url, email, password, createdAt: new Date().toISOString() };
    mkdirSync('.local', { recursive: true });
    writeFileSync(accessPath, JSON.stringify(access, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    createdJson = true;
    writeFileSync(guidePath, [
      '# ERTAD — ლოკალური შესვლა', '', `მისამართი: ${url}`, '', `Email: \`${email}\``, '',
      `პაროლი: \`${password}\``, '',
      'დეველოპმენტში შესასვლელად მხოლოდ ელფოსტა და პაროლია საჭირო. ავტენტიკატორის კოდი არ მოითხოვება.', '',
      'პროდაქშენში ყველა ვებ-მომხმარებლისთვის MFA სავალდებულო იქნება; პროდაქშენის გაშვება ამ ეტაპზე დაბლოკილია.', '',
      'ეს ანგარიში მხოლოდ ლოკალური ვებ-გარემოსთვისაა. ფუნქციები, რომელთა მიგრაცია ჯერ არ დასრულებულა, მიუწვდომელია.', '',
      'ეს ფაილი და გასაღებები Git-ში არ ხვდება. არ ჩასვა ისინი კომიტში, სქრინშოტში ან სამუშაო ანგარიშში.', '',
    ].join('\n'), { flag: 'wx', mode: 0o600 });
    createdGuide = true;
    await client.query('COMMIT');
    committed = true;
    setEnv('ERTAD_LOCAL_ADMIN', 'true');
    console.log('Local administrator created for password-only development access. Credentials: .local/ADMIN_ACCESS.md');
  }
} catch (error) {
  if (!committed) {
    await client.query('ROLLBACK');
    if (createdJson) unlinkSync(accessPath);
    if (createdGuide) unlinkSync(guidePath);
  }
  throw error;
} finally { await client.end(); await close(); }
