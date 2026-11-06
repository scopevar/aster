import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { AppError } from "../shared/core.js";
import {
  defaultSandboxNetworkConfiguration,
  sandboxNetworkConfigurationSchema,
  type SandboxNetworkConfiguration,
} from "../shared/tools/sandbox-settings.js";

/** Non-secret settings belong to this account on this execution machine. */
export class SandboxSettingsStore {
  private saving = false;
  constructor(private readonly path: string) {}
  async read() {
    let text: string | undefined;
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
        throw new AppError("invalid_input", "沙箱网络配置必须是有界普通文件。");
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    let configuration: SandboxNetworkConfiguration;
    try {
      configuration =
        text === undefined
          ? defaultSandboxNetworkConfiguration()
          : sandboxNetworkConfigurationSchema.parse(JSON.parse(text));
    } catch {
      throw new AppError(
        "invalid_input",
        "沙箱网络配置无效，请检查本机配置文件。",
      );
    }
    return {
      revision: createHash("sha256")
        .update(text ?? "<missing>")
        .digest("hex"),
      configuration,
    };
  }
  async save(
    revision: string,
    configuration: SandboxNetworkConfiguration,
    signal: AbortSignal,
  ) {
    if (this.saving) throw new AppError("conflict", "正在保存沙箱网络配置。");
    this.saving = true;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      if ((await this.read()).revision !== revision)
        throw new AppError("conflict", "沙箱配置已修改，请刷新后保存。");
      signal.throwIfAborted();
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(
        temporary,
        `${JSON.stringify(configuration, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      signal.throwIfAborted();
      await rename(temporary, this.path);
    } finally {
      this.saving = false;
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
}
