import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
} from "node:http";
import type { Socket } from "node:net";
import type { ClientRequest } from "node:http";
import type { Plugin } from "vite";
import { isLoopback } from "../backend/src/modules/security/networkIdentity";

const edge = Symbol("ertad-tunnel-ingress");
type IngressRequest = IncomingMessage & { [edge]?: boolean };

export function networkProxyHeaders(
  outgoing: ClientRequest,
  incoming: IngressRequest,
  secret: string,
) {
  // Client-supplied proxy claims never survive to the API.
  for (const name of outgoing.getHeaderNames())
    if (
      name.startsWith("cf-") ||
      name.startsWith("x-forwarded-") ||
      name.startsWith("x-ertad-") ||
      name === "forwarded"
    )
      outgoing.removeHeader(name);
  outgoing.setHeader("x-ertad-proxy-token", secret);
  if (
    incoming[edge] &&
    !incoming.headers["cf-worker"] &&
    !incoming.headers["cf-connecting-ipv6"] &&
    !incoming.headers["cf-pseudo-ipv4"]
  ) {
    outgoing.setHeader("x-ertad-source", "cloudflare");
    outgoing.setHeader(
      "x-ertad-client-ip",
      String(incoming.headers["cf-connecting-ip"] ?? ""),
    );
    outgoing.setHeader(
      "x-ertad-country",
      String(incoming.headers["cf-ipcountry"] ?? "XX"),
    );
  } else {
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(
      incoming.headers.host ?? "",
    );
    const claims = Object.keys(incoming.headers).some(
      (name) =>
        name.startsWith("cf-") ||
        name.startsWith("x-forwarded-") ||
        name.startsWith("x-ertad-") ||
        name === "forwarded",
    );
    outgoing.setHeader(
      "x-ertad-source",
      !incoming[edge] &&
        isLoopback(incoming.socket.remoteAddress) &&
        localHost &&
        !claims
        ? "local"
        : "invalid",
    );
  }
}

/** A separate loopback ingress in the existing Vite process. The tunnel alone uses this port.
 * Local-machine processes are the trusted operator boundary, never arbitrary HTTP headers. */
export function networkIngress(port: number, webPort: number): Plugin {
  return {
    name: "ertad-network-ingress",
    configureServer(server) {
      const ingress = createServer((request: IngressRequest, response) => {
        if (!isLoopback(request.socket.remoteAddress)) {
          response.writeHead(403).end();
          return;
        }
        request[edge] = true;
        server.middlewares(request, response);
      });
      // Preserve development HMR through the tunnel. No application WebSocket endpoint is added.
      ingress.on("upgrade", (request, socket, head) => {
        if (!isLoopback(request.socket.remoteAddress)) {
          socket.destroy();
          return;
        }
        const upstream = httpRequest({
          host: "127.0.0.1",
          port: webPort,
          path: request.url,
          method: "GET",
          headers: request.headers,
        });
        upstream.on("upgrade", (response, peer, initial) => {
          socket.write(
            `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
              response.rawHeaders.reduce(
                (s, v, i, a) => (i % 2 ? s : s + `${v}: ${a[i + 1]}\r\n`),
                "",
              ) +
              "\r\n",
          );
          if (initial.length) socket.write(initial);
          if (head.length) peer.write(head);
          peer.pipe(socket).pipe(peer);
          socket.on("error", () => peer.destroy());
          peer.on("error", () => socket.destroy());
        });
        upstream.on("response", (response) => {
          response.resume();
          socket.destroy();
        });
        upstream.on("error", () => socket.destroy());
        upstream.end();
      });
      const connections = new Set<Socket>();
      ingress.on("connection", socket => { connections.add(socket); socket.once("close", () => connections.delete(socket)); });
      ingress.on("error", () => {
        server.config.logger.error("ERTAD tunnel ingress could not bind");
        void server.close();
      });
      // Vite constructs the replacement before closing the old server. Bind only
      // when its HTTP listener starts, so config reloads cannot collide with the old ingress.
      server.httpServer?.once("listening", () => ingress.listen(port, "127.0.0.1"));
      server.httpServer?.once("close", () => {
        ingress.close();
        for (const socket of connections) socket.destroy();
      });
    },
  };
}
