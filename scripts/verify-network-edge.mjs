import { loadEnvFile } from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
loadEnvFile(".env");
const origin = new URL(process.env.ERTAD_TUNNEL_ORIGIN ?? "");
if (
  origin.protocol !== "https:" ||
  origin.host !== process.env.ERTAD_TUNNEL_HOST ||
  process.env.ERTAD_NETWORK_CONTROL !== "true"
)
  throw new Error("Configured network tunnel required");
const probe = (headers) =>
  fetch(new URL("/api/v1/ertad-network-probe", origin), {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
const baseline = await probe({});
const countryProbe = await probe({ "CF-IPCountry": "ZZ" });
const hopProbe = await probe({
  "X-ERTAD-Source": "local",
  "X-ERTAD-Proxy-Token": "synthetic-untrusted",
  "X-Forwarded-For": "127.0.0.1",
});
const ipProbe = await probe({ "CF-Connecting-IP": "not-an-address" });
const country = baseline.headers.get("x-ertad-network-country");
const reachesBoundary = (response) =>
  response.status === 401 &&
  response.headers.get("x-ertad-network-source") === "cloudflare" &&
  response.headers.get("x-ertad-network-country") === country;
// Cloudflare may reject a malformed IP header before forwarding it to the origin.
// Test country/hop forgery separately so an edge rejection cannot hide a country failure.
const valid =
  /^[A-Z]{2}$/.test(country ?? "") &&
  !["XX", "ZZ"].includes(country) &&
  [baseline, countryProbe, hopProbe].every(reachesBoundary) &&
  (reachesBoundary(ipProbe) || [400, 403].includes(ipProbe.status));
let env = readFileSync(".env", "utf8");
const line = `ERTAD_COUNTRY_HEADERS_VERIFIED=${valid}`;
env = /^ERTAD_COUNTRY_HEADERS_VERIFIED=.*$/m.test(env)
  ? env.replace(/^ERTAD_COUNTRY_HEADERS_VERIFIED=.*$/m, line)
  : env + "\n" + line + "\n";
writeFileSync(".env", env, { mode: 0o600 });
if (!valid)
  throw new Error(
    "Country-source verification failed. Country approval stays disabled. Verify before applying rules; check Cloudflare visitor location headers, Worker routes and Pseudo IPv4 settings.",
  );
console.log(
  "PASS anonymous edge checks: trusted country preserved, forged hop/country rejected or overwritten, malformed IP denied or replaced. Restart dev to enable country approvals. No credentials or addresses were sent/printed.",
);
