import { loadEnvFile } from "node:process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";
import { assertPortAvailable } from "./preflight.mjs";
loadEnvFile(".env");
if (process.env.NODE_ENV && process.env.NODE_ENV !== "development")
  throw new Error("Local setup only");
const port = Number(process.env.ERTAD_TUNNEL_INGRESS_PORT ?? 15174);
if (
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  [
    Number(process.env.ERTAD_API_PORT ?? 13000),
    Number(process.env.ERTAD_WEB_PORT ?? 15173),
  ].includes(port)
)
  throw new Error("Invalid ingress port");
await assertPortAvailable(port, "Tunnel ingress");
const cfgPath = "infra/cloudflared.yml";
const oldConfig = readFileSync(cfgPath, "utf8");
const config = yaml.load(oldConfig);
const routes = config.ingress.filter(
  (route) => route.hostname === process.env.ERTAD_TUNNEL_HOST,
);
if (
  routes.length !== 1 ||
  !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(routes[0].service)
)
  throw new Error("Expected exactly one local ERTAD tunnel route");
routes[0].service = `http://127.0.0.1:${port}`;
mkdirSync(".local", { recursive: true });
if (!existsSync(".local/cloudflared-before-network.yml"))
  writeFileSync(".local/cloudflared-before-network.yml", oldConfig, {
    mode: 0o600,
    flag: "wx",
  });
let env = readFileSync(".env", "utf8");
function set(name, value) {
  const line = `${name}=${value}`;
  env = new RegExp(`^${name}=.*$`, "m").test(env)
    ? env.replace(new RegExp(`^${name}=.*$`, "m"), line)
    : env.trimEnd() + "\n" + line + "\n";
}
for (const name of ["ERTAD_PROXY_SECRET", "ERTAD_NETWORK_IP_KEY"]) {
  if (process.env[name] && process.env[name].length < 32)
    throw new Error("Existing network secret is too short");
  if (!process.env[name]) set(name, randomBytes(32).toString("base64url"));
}
set("ERTAD_NETWORK_CONTROL", "true");
set("ERTAD_TUNNEL_INGRESS_PORT", String(port));
if (!process.env.ERTAD_COUNTRY_HEADERS_VERIFIED)
  set("ERTAD_COUNTRY_HEADERS_VERIFIED", "false");
writeFileSync(cfgPath, yaml.dump(config), { mode: 0o600 });
writeFileSync(".env", env, { mode: 0o600 });
console.log(
  `Local network control configured; tunnel ingress uses loopback port ${port}. Secrets preserved/generated privately. Country approval remains gated until edge verification.`,
);
