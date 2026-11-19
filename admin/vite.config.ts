import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { networkIngress, networkProxyHeaders } from "./networkIngress";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "..", "ERTAD_");
  const target = `http://127.0.0.1:${env.ERTAD_API_PORT || 13000}`;
  const allowedHosts = ["localhost", "127.0.0.1"];
  const network = env.ERTAD_NETWORK_CONTROL === "true";
  const webPort = Number(env.ERTAD_WEB_PORT || 15173);
  const ingressPort = Number(env.ERTAD_TUNNEL_INGRESS_PORT || 15174);
  if (
    network &&
    (!env.ERTAD_PROXY_SECRET ||
      env.ERTAD_PROXY_SECRET.length < 32 ||
      !Number.isInteger(ingressPort) ||
      ingressPort < 1024 ||
      ingressPort > 65535 ||
      ingressPort === webPort)
  )
    throw new Error("Invalid ERTAD network ingress configuration");
  if (env.ERTAD_TUNNEL_HOST) allowedHosts.push(env.ERTAD_TUNNEL_HOST);
  const apiProxy: ProxyOptions = {
    target,
    changeOrigin: true,
    configure(proxy) {
      // Development uses the socket peer for its shared rate limit, not forwarded
      // visitor addresses. Keep trust proxy disabled and avoid a misleading warning.
      proxy.on("proxyReq", (request, incoming) => {
        if (network)
          networkProxyHeaders(request, incoming, env.ERTAD_PROXY_SECRET);
        else request.removeHeader("x-forwarded-for");
      });
    },
  };
  return {
    plugins: [
      react(),
      ...(network ? [networkIngress(ingressPort, webPort)] : []),
    ],
    server: {
      host: "127.0.0.1",
      port: Number(env.ERTAD_WEB_PORT || 15173),
      strictPort: true,
      allowedHosts,
      proxy: {
        "/api": apiProxy,
        "/health": { target, changeOrigin: true },
      },
    },
  };
});
