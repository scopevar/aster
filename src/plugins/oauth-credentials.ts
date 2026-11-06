import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { SecretBox } from "../security/secret.js";
import { AppError } from "../shared/core.js";

const secret = z.string().min(1).max(32000);
const credentialsSchema = z.object({
  scope: z.string().max(128),
  redirectUrl: z.url().max(4096),
  client: z
    .object({
      client_id: secret,
      client_secret: secret.optional(),
      client_id_issued_at: z.number().optional(),
      client_secret_expires_at: z.number().optional(),
      issuer: z.string().optional(),
    })
    .passthrough()
    .optional(),
  tokens: z
    .object({
      access_token: secret,
      token_type: secret,
      refresh_token: secret.optional(),
      expires_in: z.number().optional(),
      scope: z.string().optional(),
      issuer: z.string().optional(),
    })
    .passthrough()
    .optional(),
});
export type OAuthCredentials = z.infer<typeof credentialsSchema>;

/** Only sealed credentials live here; backups, templates and renderer data exclude them. */
export class OAuthCredentialStore {
  constructor(
    private readonly directory: string,
    private readonly box: SecretBox,
  ) {}
  private path(key: string) {
    return join(
      this.directory,
      z.uuid().parse(key.split("/")[0]),
      `${createHash("sha256").update(key).digest("hex")}.sealed`,
    );
  }
  async read(
    key: string,
    scope: string,
  ): Promise<OAuthCredentials | undefined> {
    const path = this.path(key);
    let file;
    try {
      file = await open(path, "r");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw new AppError("unavailable", "无法读取 MCP 授权凭据。");
    }
    let data: OAuthCredentials;
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 128 * 1024 ||
        (await lstat(path)).isSymbolicLink()
      )
        throw Error("Invalid credentials");
      const value: unknown = JSON.parse(
        Buffer.from(await this.box.open(await file.readFile())).toString(
          "utf8",
        ),
      );
      data = credentialsSchema.parse(value);
    } catch {
      throw new AppError(
        "unavailable",
        "MCP 授权凭据无法解密或已损坏，请断开账号后重新连接。",
      );
    } finally {
      await file.close();
    }
    if (data.scope !== scope) return;
    if (
      (data.client && !data.client.issuer) ||
      (data.tokens && !data.tokens.issuer)
    )
      throw new AppError(
        "unauthorized",
        "旧版 MCP 授权未绑定授权服务器，请重新连接账号。原凭据已保留。",
      );
    return data;
  }
  async save(key: string, value: OAuthCredentials, check: () => void) {
    const data = Buffer.from(JSON.stringify(credentialsSchema.parse(value)));
    if (data.length > 120 * 1024)
      throw new AppError("capacity", "MCP 授权凭据超过大小限制。");
    const sealed = await this.box.seal(data);
    check();
    const path = this.path(key),
      temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(sealed);
        await file.sync();
      } finally {
        await file.close();
      }
      check();
      await rename(temporary, path);
      // A disconnect can race the atomic rename; remove a revoked result before returning.
      try {
        check();
      } catch (error) {
        await this.clear(key);
        throw error;
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
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
  async clear(key: string) {
    await unlink(this.path(key)).catch((error: unknown) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    });
  }
  async clearBot(botId: string) {
    const root = resolve(this.directory),
      path = join(root, z.uuid().parse(botId));
    if (dirname(path) !== root)
      throw new AppError("unauthorized", "MCP 凭据清理范围无效。");
    await rm(path, { recursive: true, force: true });
  }
}
