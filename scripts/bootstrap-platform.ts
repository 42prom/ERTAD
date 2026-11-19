import { loadEnvFile } from "node:process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import pg from "pg";
loadEnvFile(".env");
if (process.env.NODE_ENV && process.env.NODE_ENV !== "development")
  throw new Error("Local bootstrap only");
process.env.NODE_ENV = "development";
const port = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
if (
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !process.env.POSTGRES_PASSWORD ||
  !process.env.APP_DB_PASSWORD ||
  !process.env.API_KEY_ENCRYPTION_SECRET
)
  throw new Error("Initialize local infrastructure first");
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD)}@127.0.0.1:${port}/ertad`;
const {
  seedPlatformOperator,
  enablePlatformSessionResponse,
  enablePlatformIntegrations,
  enablePlatformPolicy,
  enablePlatformNetwork,
  enablePlatformLimits,
  enablePlatformProviders,
  enablePlatformAccountSecurity,
} = await import("./platform-fixture");
const sessions = process.argv.includes("--sessions");
const accounts = process.argv.includes('--accounts');
const providers = process.argv.includes("--providers");
const limits = process.argv.includes("--limits");
const network = process.argv.includes("--network");
const integrations = process.argv.includes("--integrations");
const policy = process.argv.includes("--policy"),
  reviewer = process.argv.includes("--reviewer");
if (reviewer && (sessions || integrations || policy))
  throw new Error(
    "Reviewer bootstrap cannot be combined with operator upgrades",
  );
if (
  process.argv
    .slice(2)
    .some(
      (arg) =>
        !["--sessions", "--integrations", "--policy", "--reviewer", "--network", "--limits", "--providers",'--accounts'].includes(
          arg,
        ),
    )
)
  throw new Error("Unknown installer option");
const { close } = await import("../backend/src/db/client");
const client = new pg.Client({
  host: "127.0.0.1",
  port,
  database: "ertad",
  user: "ertad_owner",
  password: process.env.POSTGRES_PASSWORD,
  options: "-c search_path=ertad,public",
});
const jsonPath = reviewer
    ? ".local/platform-reviewer-access.json"
    : ".local/platform-access.json",
  guidePath = reviewer
    ? ".local/PLATFORM_REVIEWER_ACCESS.md"
    : ".local/PLATFORM_ACCESS.md";
let madeJson = false,
  madeGuide = false,
  committed = false;
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(42420031)");
  if (existsSync(jsonPath)) {
    const saved = JSON.parse(readFileSync(jsonPath, "utf8"));
    if (
      !(
        await client.query(
          "SELECT 1 FROM admin_users a JOIN platform_accounts p ON p.admin_user_id=a.id WHERE a.id=$1 AND a.email=$2",
          [saved.id, saved.email],
        )
      ).rowCount
    )
      throw new Error(
        "Existing technical credentials do not match; refusing replacement",
      );
    if (sessions) await enablePlatformSessionResponse(client, saved.id);
    if(accounts) await enablePlatformAccountSecurity(client,saved.id,reviewer?'reviewer':'operator');
    if (integrations) await enablePlatformIntegrations(client, saved.id);
    if (policy) await enablePlatformPolicy(client, saved.id);
    if (limits) await enablePlatformLimits(client, saved.id, reviewer ? "reviewer" : "operator");
    if (providers) await enablePlatformProviders(client, saved.id, reviewer ? "reviewer" : "operator");
    if (network) await enablePlatformNetwork(client, saved.id, reviewer ? "reviewer" : "operator");
    await client.query("COMMIT");
    committed = true;
    console.log(
      `Existing technical account preserved; no credential reset or grant renewal. Credentials: ${guidePath}`,
    );
  } else {
    if (existsSync(guidePath))
      throw new Error("Existing credentials guide will not be overwritten");
    const account = await seedPlatformOperator(
      client,
      reviewer ? "reviewer" : "operator",
    );
    if (sessions) await enablePlatformSessionResponse(client, account.id);
    if(accounts) await enablePlatformAccountSecurity(client,account.id,reviewer?'reviewer':'operator');
    if (integrations) await enablePlatformIntegrations(client, account.id);
    if (policy) await enablePlatformPolicy(client, account.id);
    if (limits) await enablePlatformLimits(client, account.id, reviewer ? "reviewer" : "operator");
    if (providers) await enablePlatformProviders(client, account.id, reviewer ? "reviewer" : "operator");
    if (network) await enablePlatformNetwork(client, account.id, reviewer ? "reviewer" : "operator");
    mkdirSync(".local", { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(account, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    madeJson = true;
    writeFileSync(
      guidePath,
      [
        "# ERTAD — ტექნიკური ადმინისტრატორი",
        "",
        `შესვლა: http://localhost:${process.env.ERTAD_WEB_PORT ?? 15173}/login`,
        "",
        `ელფოსტა: ${account.email}`,
        `პაროლი: ${account.password}`,
        "",
        "შესვლის შემდეგ იხსნება სისტემის პანელი. დეველოპმენტში MFA კოდი არ მოითხოვება.",
        "სისტემის მდგომარეობისა და გასუფთავებული ტექნიკური ჟურნალის ნახვა. ორგანიზაციული წვდომა არ აქვს.",
        `წვდომის ვადა: ${new Date(account.validUntil).toISOString()}`,
        reviewer
          ? "უფლება: სხვისი სესიების პოლიტიკის მოთხოვნის განხილვა. შესვლა ჩვეულებრივი ელფოსტითა და პაროლით."
          : "დამატებითი შესაძლებლობები აქტიურდება მხოლოდ ინსტალერის ცალკე ოფციებით.",
        "ფაილი შეიცავს ლოკალურ საიდუმლოებებს. არ გამოაქვეყნო ან ჩასვა კომიტში.",
        "",
      ].join("\n"),
      { flag: "wx", mode: 0o600 },
    );
    madeGuide = true;
    await client.query("COMMIT");
    committed = true;
    console.log(
      `Technical ${reviewer ? "reviewer" : "operator"} created with expiring grants and no organization membership. Credentials: ${guidePath}`,
    );
  }
} catch (error) {
  if (!committed) {
    await client.query("ROLLBACK");
    if (madeJson) unlinkSync(jsonPath);
    if (madeGuide) unlinkSync(guidePath);
  }
  throw error;
} finally {
  await client.end();
  await close();
}
if (integrations)
  console.log(
    "Integration diagnostic upgrade requested; inactive providers, credentials and grant expiry remain unchanged.",
  );
console.log(`Local credentials guide: ${guidePath}`);
if (sessions)
  console.log(
    "Session-response upgrade requested; credentials, expiry and revocation were preserved. Expired/revoked accounts are not re-enabled.",
  );
