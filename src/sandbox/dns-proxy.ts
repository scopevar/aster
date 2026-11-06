import { Agent, request } from "node:https";
import { connect } from "node:tls";
import type { SandboxNetworkConfiguration } from "../shared/tools/sandbox-settings.js";

/** Only the fixed encrypted DNS endpoint can use this host-side tunnel. */
export async function openDnsProxy(
  proxy: NonNullable<SandboxNetworkConfiguration["proxy"]>,
) {
  const { Server, createTunnel, closeTunnel } = await import("proxy-chain");
  const server = new Server({
    host: "127.0.0.1",
    port: 0,
    prepareRequestFunction: ({ hostname, port, isHttp }) => ({
      requestAuthentication:
        isHttp || hostname !== "cloudflare-dns.com" || port !== 443,
      upstreamProxyUrl: `${proxy.protocol}://${proxy.address}`,
    }),
  });
  await server.listen();
  let tunnel: string;
  try {
    tunnel = await createTunnel(
      `http://127.0.0.1:${server.port}`,
      "cloudflare-dns.com:443",
      { hostname: "127.0.0.1" },
    );
  } catch (error) {
    await server.close(true);
    throw error;
  }
  const endpoint = new URL(`tcp://${tunnel}`);
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () =>
    connect({
      host: endpoint.hostname,
      port: Number(endpoint.port),
      servername: "cloudflare-dns.com",
      rejectUnauthorized: true,
    });
  const fetchDns: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (
      url.origin !== "https://cloudflare-dns.com" ||
      url.pathname !== "/dns-query"
    )
      throw new Error("DNS 代理仅允许固定的加密解析服务。");
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        url,
        {
          agent,
          signal: init?.signal ?? undefined,
          headers: { accept: "application/dns-json" },
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.destroy();
            reject(
              new Error(`加密 DNS 请求失败（HTTP ${response.statusCode}）。`),
            );
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 65536)
              response.destroy(new Error("DNS 响应超过大小限制。"));
            else chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () =>
            resolve(new Response(Buffer.concat(chunks))),
          );
        },
      );
      outgoing.once("error", reject);
      outgoing.end();
    });
  };
  return {
    request: fetchDns,
    async close() {
      agent.destroy();
      try {
        await closeTunnel(tunnel, true);
      } finally {
        await server.close(true);
      }
    },
  };
}
