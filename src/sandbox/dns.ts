import { createSocket, type Socket } from "node:dgram";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { publicWebAddress, resolvePublicDns } from "../network/web-policy.js";

type Answer = Awaited<ReturnType<typeof resolvePublicDns>>;

/** A loopback resolver for approved names only. The VM never receives host proxy settings or secrets. */
export class SandboxDns {
  private readonly controller = new AbortController();
  private readonly tasks = new Set<Promise<void>>();
  private readonly answers = new Map<
    string,
    { expires: number; answer: Promise<Answer> }
  >();
  private readonly socket: Socket = createSocket("udp4");
  private closing: Promise<void> | undefined;
  error = "";
  constructor(
    private readonly hosts: readonly string[],
    private readonly resolve = resolvePublicDns,
  ) {}

  async open() {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.bind(0, "127.0.0.1", () => {
        this.socket.removeListener("error", reject);
        resolve();
      });
    });
    this.socket.on("error", () => {
      this.error = "加密 DNS 服务不可用。";
      this.controller.abort();
    });
    this.socket.on("message", (query, peer) => {
      if (this.controller.signal.aborted || this.tasks.size >= 8) return;
      const task = this.reply(query)
        .then((response) => {
          if (response && !this.controller.signal.aborted)
            this.socket.send(response, peer.port, peer.address, (error) => {
              if (error) this.error = "加密 DNS 响应发送失败。";
            });
        })
        .catch(() => {
          this.error = "加密 DNS 响应失败。";
        });
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task));
    });
    const address = this.socket.address();
    return `${address.address}:${address.port}`;
  }

  private async reply(query: Buffer) {
    if (
      query.length < 17 ||
      query.length > 4096 ||
      query.readUInt16BE(4) !== 1 ||
      (query.readUInt16BE(2) & 0xf800) !== 0
    )
      return null;
    let offset = 12;
    const labels: string[] = [];
    while (offset < query.length && query[offset] !== 0) {
      const length = query[offset++] ?? 0;
      if (length > 63 || offset + length >= query.length) return null;
      labels.push(query.subarray(offset, offset + length).toString("ascii"));
      offset += length;
    }
    if (offset + 5 > query.length) return null;
    offset++;
    const hostname = labels.join(".").toLowerCase();
    const type = query.readUInt16BE(offset);
    const questionEnd = offset + 4;
    const header = Buffer.from(query.subarray(0, questionEnd));
    header.writeUInt16BE(0x8080 | (query.readUInt16BE(2) & 0x0100), 2);
    header.writeUInt16BE(0, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    if (
      !this.hosts.includes(hostname) ||
      query.readUInt16BE(offset + 2) !== 1
    ) {
      header.writeUInt16BE(header.readUInt16BE(2) | 3, 2);
      return header;
    }
    if (type !== 1 && type !== 28) return header;
    try {
      let cached = this.answers.get(hostname);
      if (!cached || cached.expires <= Date.now()) {
        const answer = this.resolve(
          hostname,
          AbortSignal.any([this.controller.signal, AbortSignal.timeout(8000)]),
        );
        cached = { expires: Date.now() + 8000, answer };
        this.answers.set(hostname, cached);
        void answer.then(
          (result) => {
            const current = this.answers.get(hostname);
            if (current?.answer === answer)
              current.expires =
                Date.now() + Math.min(result.ttlSeconds, 300) * 1000;
          },
          () => {
            this.answers.delete(hostname);
          },
        );
      }
      const answer = await cached.answer;
      if (
        !answer.addresses.length ||
        answer.addresses.some((a) => !publicWebAddress(a.address))
      )
        throw new Error("加密 DNS 返回了非公网地址，已阻止连接。");
      this.error = "";
      const addresses = answer.addresses
        .filter((a) => isIP(a.address) === (type === 1 ? 4 : 6))
        .slice(0, 16);
      const records = addresses.map(({ address }) => {
        const data = Buffer.from(ipaddr.parse(address).toByteArray());
        const record = Buffer.alloc(12);
        record.writeUInt16BE(0xc00c, 0);
        record.writeUInt16BE(type, 2);
        record.writeUInt16BE(1, 4);
        record.writeUInt32BE(Math.min(answer.ttlSeconds, 300), 6);
        record.writeUInt16BE(data.length, 10);
        return Buffer.concat([record, data]);
      });
      header.writeUInt16BE(records.length, 6);
      return Buffer.concat([header, ...records]);
    } catch (error) {
      this.error =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "加密 DNS 查询失败。";
      header.writeUInt16BE(header.readUInt16BE(2) | 2, 2);
      return header;
    }
  }
  close() {
    return (this.closing ??= (async () => {
      this.controller.abort();
      await Promise.allSettled([...this.tasks]);
      await new Promise<void>((resolve, reject) => {
        try {
          this.socket.close(() => resolve());
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ERR_SOCKET_DGRAM_NOT_RUNNING"
          )
            resolve();
          else reject(error);
        }
      });
      this.answers.clear();
    })());
  }
}
