import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AuthOperationOptions,
  Credential,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { defaultSecretBox } from "../security/secret.js";
import { ownDirectory } from "../platform/directory-lease.js";
import { AppError } from "../shared/core.js";

export interface RunCredentials extends CredentialStore {
  close(): Promise<void>;
}

const credentialSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("api_key"),
      key: z.string().max(16000).optional(),
      env: z.record(z.string().max(100), z.string().max(16000)).optional(),
    })
    .strict()
    .transform((value) => ({
      type: value.type,
      ...(value.key !== undefined ? { key: value.key } : {}),
      ...(value.env !== undefined ? { env: value.env } : {}),
    })),
  z
    .object({
      type: z.literal("oauth"),
      refresh: z.string().max(16000),
      access: z.string().max(16000),
      expires: z.number(),
    })
    .catchall(z.unknown()),
]);
const schema = z
  .object({
    version: z.literal(1),
    entries: z.record(
      z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
      z.object({ generation: z.uuid(), credential: credentialSchema }).strict(),
    ),
  })
  .strict();
type Data = z.infer<typeof schema>;
const queues = new Map<string, Promise<unknown>>();

/** OS-sealed Pi credentials. Login changes generation; scoped OAuth refreshes retain it. */
export class PiCredentials implements CredentialStore {
  private readonly path: string;
  private readonly home: string;
  private readonly box;
  private metadata:
    | {
        revision: string;
        entries: { providerId: string; type: Credential["type"] }[];
      }
    | undefined;
  constructor(home: string) {
    this.home = resolve(home);
    this.path = join(this.home, "pi-auth.sealed");
    this.box = defaultSecretBox(this.home);
  }
  private async sealed(): Promise<Buffer | undefined> {
    let file;
    try {
      file = await open(this.path, "r");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (await lstat(this.path)).isSymbolicLink() ||
        stat.size > 1024 * 1024
      )
        throw Error("Invalid credential storage");
      return await file.readFile();
    } finally {
      await file.close();
    }
  }
  private async decode(sealed: Buffer | undefined): Promise<Data> {
    if (sealed === undefined) return { version: 1, entries: {} };
    return schema.parse(
      JSON.parse(Buffer.from(await this.box.open(sealed)).toString("utf8")),
    );
  }
  private async data(): Promise<Data> {
    return this.decode(await this.sealed());
  }
  private async serialized<T>(task: () => Promise<T>): Promise<T> {
    const key =
      process.platform === "win32" ? this.path.toLowerCase() : this.path;
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        await mkdir(this.home, { recursive: true });
        const lease = await ownDirectory(this.home, "pi-auth");
        try {
          return await task();
        } finally {
          await lease.close();
        }
      });
    queues.set(key, next);
    try {
      return await next;
    } finally {
      if (queues.get(key) === next) queues.delete(key);
    }
  }
  async read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return (await this.data()).entries[providerId]?.credential;
  }
  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    const sealed = await this.sealed();
    const revision = sealed
      ? createHash("sha256").update(sealed).digest("hex")
      : "missing";
    if (!this.metadata || this.metadata.revision !== revision) {
      const data = await this.decode(sealed);
      // Cache only public metadata; credential reads still decrypt fresh data.
      this.metadata = {
        revision,
        entries: Object.entries(data.entries).map(([providerId, value]) => ({
          providerId,
          type: value.credential.type,
        })),
      };
    }
    return this.metadata.entries.map((entry) => ({ ...entry }));
  }
  private async write(data: Data, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const plain = Buffer.from(JSON.stringify(schema.parse(data)));
    if (plain.byteLength > 1024 * 1024 - 1024)
      throw Error("Credential storage exceeded its limit");
    const sealed = await this.box.seal(plain);
    if (sealed.byteLength > 1024 * 1024)
      throw Error("Sealed credential storage exceeded its limit");
    await mkdir(this.home, { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(sealed);
        await file.sync();
      } finally {
        await file.close();
      }
      signal?.throwIfAborted();
      await rename(temp, this.path);
    } finally {
      await unlink(temp).catch((error: unknown) => {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      });
    }
  }
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    return this.serialized(async () => {
      options?.signal?.throwIfAborted();
      const data = await this.data(),
        next = await fn(data.entries[providerId]?.credential);
      if (next !== undefined) {
        data.entries[providerId] = {
          generation: randomUUID(),
          credential: credentialSchema.parse(next),
        };
        await this.write(data, options?.signal);
      }
      return data.entries[providerId]?.credential;
    });
  }
  delete(providerId: string, options?: AuthOperationOptions) {
    return this.serialized(async () => {
      options?.signal?.throwIfAborted();
      const data = await this.data();
      delete data.entries[providerId];
      await this.write(data);
    });
  }
  /** Pins account identity for a run while sharing refresh coordination across concurrent runs. */
  async scoped(
    providerId: string,
    signal: AbortSignal,
  ): Promise<RunCredentials> {
    signal.throwIfAborted();
    const initial = (await this.data()).entries[providerId];
    const generation = initial?.generation;
    let snapshot: Credential | undefined = initial?.credential;
    let closed = false;
    const active = new Set<Promise<unknown>>();
    const track = async <T>(work: Promise<T>): Promise<T> => {
      active.add(work);
      try {
        return await work;
      } finally {
        active.delete(work);
      }
    };
    const check = (requested: string, options?: AuthOperationOptions) => {
      signal.throwIfAborted();
      if (closed) throw new AppError("unavailable", "模型认证运行范围已结束。");
      options?.signal?.throwIfAborted();
      return requested === providerId;
    };
    return {
      read: async (requested, options) => {
        if (!check(requested, options)) return undefined;
        if (snapshot?.type !== "oauth") return snapshot;
        const current = (await track(this.data())).entries[providerId];
        if (current?.generation === generation) snapshot = current?.credential;
        return snapshot;
      },
      list: async (options) => {
        check(providerId, options);
        return snapshot ? [{ providerId, type: snapshot.type }] : [];
      },
      modify: async (requested, fn, options) => {
        if (!check(requested, options))
          throw Error("Credential scope mismatch");
        return track(
          this.serialized(async () => {
            check(requested, options);
            const data = await this.data(),
              current = data.entries[providerId];
            const matching = current?.generation === generation;
            if (matching) snapshot = current?.credential;
            const next = await fn(snapshot);
            if (next !== undefined) {
              snapshot = credentialSchema.parse(next);
              if (matching && generation) {
                data.entries[providerId] = {
                  generation,
                  credential: credentialSchema.parse(next),
                };
                await this.write(data);
              }
            }
            return snapshot;
          }),
        );
      },
      delete: async () => {
        throw Error("A run cannot revoke stored credentials");
      },
      close: async () => {
        closed = true;
        const results = await Promise.allSettled([...active]);
        for (const result of results)
          if (
            result.status === "rejected" &&
            !(
              result.reason instanceof Error &&
              result.reason.name === "AbortError"
            )
          )
            throw new AppError(
              "unknown",
              "模型认证更新未能确认；已等待刷新结束，请核实后重新认证。",
            );
      },
    };
  }
}
