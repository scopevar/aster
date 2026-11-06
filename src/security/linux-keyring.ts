import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { aesSecretBox } from "./secret-box.js";

const prefix = Buffer.from("aster-keyring-v1\0");

async function secretTool(args: string[], input?: string) {
  return await new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn("secret-tool", args, {
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let size = 0,
        failed = false;
      const timer = setTimeout(() => {
        failed = true;
        child.kill("SIGKILL");
      }, 10000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16384) {
          failed = true;
          child.kill("SIGKILL");
        } else chunks.push(chunk);
      });
      child.stdin.on("error", () => {
        failed = true;
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(
          new Error(
            "Linux 系统密钥环需要 secret-tool 和可用的 Secret Service；无图形环境可安全注入 ASTER_CLOUD_SECRET_KEY。",
          ),
        );
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (failed)
          reject(new Error("Linux 系统密钥环操作失败或超时，未保存明文。"));
        else
          resolve({
            code,
            output: Buffer.concat(chunks).toString("utf8").trim(),
          });
      });
      child.stdin.end(input);
    },
  );
}

/** The keyring owns the wrapping key; disk contains only an authenticated wrapper.
 * Existing Electron wrappers require their original context until explicit migration. */
export async function linuxKeyringCrypt(
  directory: string,
  mode: "seal" | "open",
  payload: Buffer,
  legacyOpen: () => Promise<Buffer>,
  destinationIdentity?: string,
) {
  if (mode === "open" && !payload.subarray(0, prefix.length).equals(prefix))
    return legacyOpen();
  const identity = createHash("sha256")
    .update(destinationIdentity ?? (await realpath(directory)))
    .digest("hex");
  const attributes = [
    "application",
    "aster",
    "purpose",
    "daemon-key",
    "directory",
    identity,
  ];
  const found = await secretTool(["lookup", ...attributes]);
  let hex = found.output;
  if (found.code !== 0) {
    if (found.code !== 1 || mode !== "seal")
      throw new Error("Linux 系统密钥环不可用或缺少原始密钥，未生成替代密钥。");
    hex = randomBytes(32).toString("hex");
    const saved = await secretTool(
      ["store", "--label=aster daemon", ...attributes],
      hex,
    );
    if (saved.code !== 0)
      throw new Error("Linux 系统密钥环未确认保存，未写入凭据。");
  }
  if (!/^[a-f0-9]{64}$/i.test(hex))
    throw new Error("Linux 系统密钥环中的密钥格式无效。");
  const box = aesSecretBox(Buffer.from(hex, "hex"));
  return mode === "seal"
    ? Buffer.concat([prefix, await box.seal(payload)])
    : Buffer.from(await box.open(payload.subarray(prefix.length)));
}
