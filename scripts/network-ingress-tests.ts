import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "vite";
import { networkIngress, networkProxyHeaders } from "../admin/networkIngress";
export async function verifyNetworkIngress() {
  const secret = "synthetic-proxy-key-".repeat(3);
  const backend = httpServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        source: req.headers["x-ertad-source"],
        country: req.headers["x-ertad-country"],
        ip: req.headers["x-ertad-client-ip"],
        authenticated: req.headers["x-ertad-proxy-token"] === secret,
        leaked: Object.keys(req.headers).filter(
          (h) =>
            h.startsWith("cf-") ||
            h.startsWith("x-forwarded-") ||
            h === "forwarded",
        ),
      }),
    );
  });
  backend.listen(0, "127.0.0.1");
  await new Promise<void>((r) => backend.once("listening", r));
  const port = (backend.address() as AddressInfo).port;
  const reserve = httpServer();
  reserve.listen(0, "127.0.0.1");
  await new Promise<void>((r) => reserve.once("listening", r));
  const ingressPort = (reserve.address() as AddressInfo).port;
  await new Promise<void>((r) => reserve.close(() => r()));
  const webReserve = httpServer();
  webReserve.listen(0, "127.0.0.1");
  await new Promise<void>((r) => webReserve.once("listening", r));
  const reservedWebPort = (webReserve.address() as AddressInfo).port;
  await new Promise<void>((r) => webReserve.close(() => r()));
  const vite = await createServer({
    configFile: false,
    root: process.cwd() + "/admin",
    logLevel: "silent",
    plugins: [networkIngress(ingressPort, reservedWebPort)],
    server: {
      host: "127.0.0.1",
      port: reservedWebPort,
      strictPort: true,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:" + port,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (out, incoming) =>
              networkProxyHeaders(out, incoming, secret),
            );
          },
        },
      },
    },
  });
  try {
    await vite.listen();
    const webPort = (vite.httpServer!.address() as AddressInfo).port;
    const probe = async (p: number, headers: Record<string, string> = {}) =>
      (await fetch("http://127.0.0.1:" + p + "/api/test", { headers })).json();
    assert.equal((await probe(webPort)).source, "local");
    const forged = await probe(webPort, {
      "cf-connecting-ip": "192.0.2.1",
      "cf-ipcountry": "GE",
      "x-ertad-proxy-token": secret,
      "x-ertad-source": "cloudflare",
    });
    assert.equal(forged.source, "invalid");
    assert.deepEqual(forged.leaked, []);
    const edge = await probe(ingressPort, {
      "cf-connecting-ip": "192.0.2.1",
      "cf-ipcountry": "GE",
      "x-ertad-source": "local",
      "x-forwarded-for": "127.0.0.1",
      forwarded: "for=127.0.0.1",
    });
    assert.equal(edge.source, "cloudflare");
    assert.equal(edge.ip, "192.0.2.1");
    assert.equal(edge.country, "GE");
    assert(edge.authenticated);
    assert.deepEqual(edge.leaked, []);
    for (const h of ["cf-worker", "cf-connecting-ipv6", "cf-pseudo-ipv4"])
      assert.equal(
        (
          await probe(ingressPort, {
            "cf-connecting-ip": "192.0.2.1",
            "cf-ipcountry": "GE",
            [h]: "untrusted",
          })
        ).source,
        "invalid",
      );
    await vite.restart();
    assert.equal((await probe(ingressPort, { "cf-connecting-ip": "192.0.2.1", "cf-ipcountry": "GE" })).source, "cloudflare");
    console.log(
      "PASS separate ingress boundary, forged headers, stripped claims and unsupported edge metadata",
    );
  } finally {
    await vite.close();
    await new Promise<void>((r) => backend.close(() => r()));
  }
}
