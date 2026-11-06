import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "../shared/core.js";
import { agentConnectionsConfigSchema } from "../shared/agent-connections.js";

export const maxAgentConfigBytes = 1024 * 1024;
export function modelConfigPath(workspace: string) {
  return join(workspace, "pi-models.json");
}
export function defaultConfig() {
  return agentConnectionsConfigSchema.parse({
    defaultAgent: "",
    connections: [],
  });
}
export function configRevision(text: string | undefined) {
  return createHash("sha256")
    .update(text ?? "<missing>")
    .digest("hex");
}
export function readAgentConfig(path: string) {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > maxAgentConfigBytes
    )
      throw new AppError("invalid_input", "Pi 模型配置必须是有界普通文件。");
    const text = readFileSync(path, "utf8");
    return {
      text,
      config: agentConnectionsConfigSchema.parse(JSON.parse(text)),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { text: undefined, config: defaultConfig() };
    throw new AppError(
      "invalid_input",
      "Pi 模型配置无效，请检查本应用配置文件。",
    );
  }
}
