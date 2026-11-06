import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import ipaddr from "ipaddr.js";
import { z } from "zod";

export class WebAccessError extends Error {
  constructor(
    readonly status: 400 | 403 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}
const dnsAnswer = z.object({
  Status: z.literal(0),
  TC: z.literal(false),
  Answer: z
    .array(
      z.object({
        type: z.number().int(),
        TTL: z.number().int().nonnegative(),
        data: z.string().max(1024),
      }),
    )
    .max(128)
    .default([]),
});
export type WebAddress = { address: string; family: 4 | 6 };
export type WebTarget = WebAddress & { hostname: string; port: number };

/** Conservative public-unicast boundary, including IPv4-mapped IPv6. */
export function publicWebAddress(value: string): boolean {
  if (!isIP(value) || value.includes("%")) return false;
  const parsed = ipaddr.process(value);
  return (
    parsed.range() === "unicast" &&
    (parsed.kind() === "ipv4" ||
      ((parsed.toByteArray()[0] ?? 0) & 0xe0) === 0x20)
  );
}

/** Resolve only the fixed public DoH service; user input never selects the resolver URL. */
export async function resolvePublicDns(
  hostname: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<{ addresses: WebAddress[]; ttlSeconds: number }> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const tasks = [1, 28].map(async (type) => {
    const response = await request(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      {
        headers: { accept: "application/dns-json" },
        redirect: "error",
        signal: combined,
      },
    );
    if (!response.ok || !response.body)
      throw new WebAccessError(502, "Encrypted DNS is unavailable.");
    const reader = response.body.getReader();
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 65536)
          throw new WebAccessError(502, "DNS response exceeds its limit.");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const value = dnsAnswer.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    return value.Answer.filter((answer) => answer.type === type).map(
      (answer): WebAddress & { ttl: number } => {
        const family = isIP(answer.data);
        if ((family !== 4 && family !== 6) || family !== (type === 1 ? 4 : 6))
          throw new WebAccessError(502, "DNS returned an invalid address.");
        return { address: answer.data, family, ttl: answer.TTL };
      },
    );
  });
  let reads;
  try {
    reads = await Promise.all(tasks);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(tasks);
    throw error;
  }
  const answers = reads.flat();
  return {
    addresses: answers.map(({ address, family }) => ({ address, family })),
    ttlSeconds: Math.min(300, ...answers.map((answer) => answer.ttl)),
  };
}

/** Owns bounded DNS work/cache. No network connection may re-resolve a returned target. */
export class WebPolicy {
  private active = 0;
  private readonly cache = new Map<
    string,
    { expiresAt: number; addresses: WebAddress[] }
  >();
  private readonly local = new Set(
    Object.values(networkInterfaces()).flatMap((items) =>
      (items ?? []).map((item) => ipaddr.process(item.address).toString()),
    ),
  );
  constructor(private readonly resolveDns = resolvePublicDns) {}

  async target(
    method: string,
    raw: string,
    signal: AbortSignal,
  ): Promise<WebTarget> {
    if (raw.length > 8192 || /[\s\\]/.test(raw))
      throw new WebAccessError(400, "Invalid web destination.");
    const tunnel = method === "CONNECT";
    if (tunnel && !/^(?:\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+):443$/.test(raw))
      throw new WebAccessError(403, "Only HTTPS port 443 is available.");
    let url: URL;
    try {
      url = new URL(tunnel ? `https://${raw}` : raw);
    } catch {
      throw new WebAccessError(400, "Invalid web destination.");
    }
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.protocol !== (tunnel ? "https:" : "http:") ||
      url.port
    )
      throw new WebAccessError(
        403,
        "Only public HTTP 80 and HTTPS 443 are available; URL credentials are not allowed.",
      );
    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const family = isIP(hostname);
    if (
      !family &&
      (!hostname.includes(".") ||
        hostname.length > 253 ||
        hostname
          .split(".")
          .some(
            (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
          ) ||
        /\.(?:localhost|local|internal|test|invalid)$/.test(hostname))
    )
      throw new WebAccessError(
        403,
        "Local and invalid names are not available.",
      );
    signal.throwIfAborted();
    let addresses: WebAddress[];
    if (family === 4 || family === 6)
      addresses = [{ address: hostname, family }];
    else {
      const cached = this.cache.get(hostname);
      if (cached && cached.expiresAt > Date.now()) addresses = cached.addresses;
      else {
        if (this.active >= 32)
          throw new WebAccessError(
            503,
            "DNS is busy; retry after existing requests finish.",
          );
        this.active++;
        try {
          const answer = await this.resolveDns(
            hostname,
            AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          );
          signal.throwIfAborted();
          addresses = answer.addresses;
          this.validate(addresses);
          if (this.cache.size >= 512) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
          }
          if (answer.ttlSeconds > 0)
            this.cache.set(hostname, {
              addresses,
              expiresAt: Date.now() + Math.min(answer.ttlSeconds, 300) * 1000,
            });
        } finally {
          this.active--;
        }
      }
    }
    this.validate(addresses);
    const address =
      addresses.find((candidate) => candidate.family === 4) ?? addresses[0];
    if (!address) throw new WebAccessError(502, "No public address was found.");
    return { ...address, hostname, port: tunnel ? 443 : 80 };
  }
  private validate(addresses: WebAddress[]) {
    if (!addresses.length)
      throw new WebAccessError(502, "No public address was found.");
    if (
      addresses.some(
        (value) =>
          !publicWebAddress(value.address) ||
          this.local.has(ipaddr.process(value.address).toString()),
      )
    )
      throw new WebAccessError(
        403,
        "Private, local and reserved addresses are not available.",
      );
  }
}
