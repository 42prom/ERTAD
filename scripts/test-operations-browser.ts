import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import pino from "pino";
loadEnvFile(".env");
const database = `ertad_operations_test_${randomBytes(8).toString("hex")}`,
  port = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
const config = {
  host: "127.0.0.1",
  port,
  user: "ertad_owner",
  password: process.env.POSTGRES_PASSWORD,
};
const control = new pg.Client({ ...config, database: "ertad" }),
  owner = new pg.Client({
    ...config,
    database,
    options: "-c search_path=ertad,public",
  });
process.env.NODE_ENV = "test";
process.env.ERTAD_WEB_DEMO = "true";
process.env.API_KEY_ENCRYPTION_SECRET = randomBytes(32).toString("base64url");
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${port}/${database}`;
let created = false,
  connected = false,
  close: (() => Promise<void>) | undefined;
await control.connect();
try {
  await control.query(`CREATE DATABASE ${database}`);
  created = true;
  execFileSync(
    process.execPath,
    ["--import", "tsx", "backend/src/migrate.ts"],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: `postgresql://ertad_owner:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:${port}/${database}`,
      },
    },
  );
  await owner.connect();
  connected = true;
  close = (await import("../backend/src/db/client")).close;
  const { seedWebDemo } = await import("./web-demo-fixture");
  const { enableDemoWork } = await import("./web-demo-work"),
    { enableDemoWorkNeeds } = await import("./web-demo-work-needs"),
    { enableDemoCollective } = await import("./web-demo-collective"),
    { enableDemoContribution } = await import("./web-demo-contribution");
  await owner.query("BEGIN");
  const access = await seedWebDemo(owner);
  await enableDemoWork(owner, access);
  await enableDemoWorkNeeds(owner, access);
  await enableDemoCollective(owner, access);
  await enableDemoContribution(owner, access);
  await owner.query("COMMIT");
  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin"),
    { verifyOperationsBrowser } = await import("./operations-browser");
  const app = createApp(
    {
      postgres: async () => {},
      redis: async () => {},
      storage: async () => {},
    },
    pino({ level: "silent" }),
    "http://localhost:15173",
    createLocalAdminRouter("http://localhost:15173", () => access),
  );
  await verifyOperationsBrowser(app, access);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
