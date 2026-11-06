import { loadEnvFile } from "node:process";
import { join } from "node:path";

/** Shell variables take precedence; never log environment values. */
export function loadProjectEnv(root) {
  try {
    loadEnvFile(join(root, ".env"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw new Error("无法读取项目 .env，请检查文件内容和访问权限。");
  }
}
