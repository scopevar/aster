import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aesSecretBox, type SecretBox } from "./secret-box.js";
import { linuxKeyringCrypt } from "./linux-keyring.js";
export { aesSecretBox, type SecretBox } from "./secret-box.js";

async function dpapi(bytes: Uint8Array, decrypt: boolean) {
  if (bytes.byteLength > 16_384) throw new Error("登录凭据超过大小限制。");
  const operation = decrypt ? "Unprotect" : "Protect";
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $outputBytes=[Security.Cryptography.ProtectedData]::${operation}($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($outputBytes))`;
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0,
      failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32_768) {
        failed = true;
        child.kill();
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {
      failed = true;
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Windows 凭据保护组件无法启动。"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) {
        reject(new Error("Windows 凭据保护失败或超过 10 秒，未保存明文。"));
        return;
      }
      const encoded = Buffer.concat(chunks).toString("utf8").trim();
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          encoded,
        )
      ) {
        reject(new Error("Windows 凭据响应无效。"));
        return;
      }
      resolve(Buffer.from(encoded, "base64"));
    });
    child.stdin.end(Buffer.from(bytes).toString("base64"));
  });
}

function dpapiSecretBox(): SecretBox {
  return {
    seal: (plain) => dpapi(plain, false),
    open: (sealed) => dpapi(sealed, true),
  };
}

const dpapiWrapper = Buffer.from("aster-dpapi-v1\0");
function isDpapiWrapper(payload: Buffer) {
  return payload.subarray(0, dpapiWrapper.length).equals(dpapiWrapper);
}

function projectRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "../..");
}

async function electronBinary() {
  const override = process.env.ASTER_ELECTRON_BIN;
  if (override) return override;
  const root = projectRoot();
  const require = createRequire(join(root, "package.json"));
  const directory = dirname(require.resolve("electron"));
  const relative = (await readFile(join(directory, "path.txt"), "utf8")).trim();
  if (!relative) throw new Error("Electron 程序路径记录为空。");
  const binary = join(
    process.env.ELECTRON_OVERRIDE_DIST_PATH || join(directory, "dist"),
    relative,
  );
  await access(
    binary,
    process.platform === "win32" ? constants.F_OK : constants.X_OK,
  );
  return binary;
}

function hostScript() {
  return fileURLToPath(
    new URL("../platform/safe-storage-host.cjs", import.meta.url),
  );
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function stopElectron(child: ChildProcess) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Electron safeStorage, same OS crypt VS Code uses. Exit 3 means the desktop
 * keyring is not usable and the caller should retry with the basic text store. */
async function electronCrypt(
  directory: string,
  mode: "seal" | "open",
  payload: Buffer,
  plain: boolean,
  strict = process.env.ASTER_STRICT_SECRETS === "1",
) {
  const userData = join(directory, "safe-storage");
  await mkdir(userData, { recursive: true });
  const stamp = randomUUID();
  const input = join(directory, `.os-crypt.${stamp}.in`);
  const output = join(directory, `.os-crypt.${stamp}.out`);
  await writeFile(input, payload, { mode: 0o600, flag: "wx" });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete env[key];
  env.ASTER_SAFE_STORAGE_DIR = userData;
  env.ASTER_STRICT_SECRETS = strict ? "1" : "0";
  env.ASTER_SAFE_STORAGE_MODE = mode;
  env.ASTER_SAFE_STORAGE_IN = input;
  env.ASTER_SAFE_STORAGE_OUT = output;
  if (plain) env.ASTER_SAFE_STORAGE_PLAIN = "1";
  else delete env.ASTER_SAFE_STORAGE_PLAIN;
  const args = ["--disable-gpu", `--user-data-dir=${userData}`];
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY)
    args.unshift("--ozone-platform=headless");
  // Dev passes the project so entry.cjs can run the helper. A packaged
  // executable already starts there. Only a raw Electron binary, used outside
  // the desktop, is given the helper file directly.
  const entry = process.env.ASTER_ELECTRON_APP;
  if (entry) args.push(entry);
  else if (!process.env.ASTER_ELECTRON_BIN) args.push(hostScript());
  try {
    const binary = await electronBinary();
    const child = spawn(binary, args, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    const outcome = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const timer = setTimeout(() => stopElectron(child), 20_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(Object.assign(error, { spawnFailed: true }));
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    if (outcome.code === 3 || outcome.signal)
      throw Object.assign(new Error("系统密钥环暂不可用。"), {
        retryPlain: true,
      });
    if (outcome.code !== 0)
      throw new Error(
        stderr.trim().slice(0, 300) || "系统凭据保护失败，登录状态未能保存。",
      );
    return await readFile(output);
  } catch (error) {
    if (error instanceof Error && "retryPlain" in error) throw error;
    if (
      error instanceof Error &&
      "spawnFailed" in error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      throw new Error("Electron 凭据保护无法启动。");
    throw error;
  } finally {
    await rm(input, { force: true });
    await rm(output, { force: true });
  }
}

type OsCrypt = (
  directory: string,
  mode: "seal" | "open",
  payload: Buffer,
  plain: boolean,
) => Promise<Buffer>;

const systemCrypt: OsCrypt = async (directory, mode, payload, plain) => {
  if (process.platform === "linux")
    return linuxKeyringCrypt(directory, mode, payload, () =>
      electronCrypt(directory, mode, payload, plain),
    );
  if (process.platform === "win32") {
    if (mode === "seal")
      return Buffer.concat([dpapiWrapper, await dpapi(payload, false)]);
    if (isDpapiWrapper(payload))
      return dpapi(payload.subarray(dpapiWrapper.length), true);
  }
  return electronCrypt(directory, mode, payload, plain);
};

async function protectKey(
  directory: string,
  mode: "seal" | "open",
  payload: Buffer,
  crypt: OsCrypt,
  readOnly = false,
) {
  const marker = join(directory, "os-crypt.backend");
  let plainFirst = false;
  try {
    plainFirst = (await readFile(marker, "utf8")).trim() === "plain";
  } catch {
    plainFirst = false;
  }
  const finish = async (plain: boolean) => {
    const output = await crypt(directory, mode, payload, plain);
    if (!readOnly)
      await writeFile(marker, plain ? "plain" : "os", { mode: 0o600 }).catch(
        () => undefined,
      );
    return output;
  };
  // The desktop keyring is the same store VS Code uses. When it cannot run,
  // the basic text store still persists the key across restarts.
  if (readOnly || process.env.ASTER_STRICT_SECRETS === "1") {
    if (plainFirst)
      throw new Error(
        "旧凭据使用 basic text 后端。请在原环境显式迁移到系统密钥环；daemon 未改写原密钥。",
      );
    return finish(false);
  }
  if (plainFirst) return finish(true);
  try {
    return await finish(false);
  } catch (primary) {
    try {
      return await finish(true);
    } catch {
      throw primary;
    }
  }
}

async function directoryMask(directory: string) {
  return createHash("sha256")
    .update((await realpath(directory)).toLowerCase())
    .digest();
}

function xorKey(key: Buffer, mask: Buffer) {
  const out = Buffer.alloc(32);
  for (let index = 0; index < 32; index += 1)
    out[index] = (key[index] ?? 0) ^ (mask[index] ?? 0);
  return out;
}

/** Wraps the directory's AES key with the selected OS backend. The default keeps
 * the legacy Electron format; native callers select their backend explicitly.
 * Opening ciphertext never creates a replacement for a missing wrapping key. */
export function safeStorageSecretBox(
  directory: string,
  crypt: OsCrypt = electronCrypt,
  readOnly = false,
): SecretBox {
  let cached: Promise<Buffer> | undefined;
  const keyPromise = (create: boolean) =>
    (cached ??= (async () => {
      const path = join(directory, "os-crypt.key");
      const mask = await directoryMask(directory);
      let existing: Buffer | undefined;
      try {
        existing = await readFile(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (existing) {
        try {
          const opened = (
            await protectKey(directory, "open", existing, crypt, readOnly)
          )
            .toString("utf8")
            .trim();
          if (!/^[a-f0-9]{64}$/i.test(opened))
            throw new Error("登录凭据密钥无法打开。");
          return xorKey(Buffer.from(opened, "hex"), mask);
        } catch (error) {
          const strict = process.env.ASTER_STRICT_SECRETS === "1";
          if (!create || readOnly || strict) throw error;
          // A key sealed by another safeStorage context cannot be opened here.
          // Drop it and create one the running main process can persist.
          if (error instanceof Error && "retryPlain" in error) throw error;
          await unlink(path).catch((unlinkError: unknown) => {
            if (!isMissing(unlinkError)) throw unlinkError;
          });
        }
      }
      if (!create || readOnly)
        throw new Error("已有凭据缺少原始密钥，未生成替代密钥。");
      const key = randomBytes(32);
      const sealed = await protectKey(
        directory,
        "seal",
        Buffer.from(xorKey(key, mask).toString("hex"), "utf8"),
        crypt,
      );
      try {
        await writeFile(path, sealed, { mode: 0o600, flag: "wx" });
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
        const existing = await readFile(path);
        const opened = (await protectKey(directory, "open", existing, crypt))
          .toString("utf8")
          .trim();
        if (!/^[a-f0-9]{64}$/i.test(opened))
          throw new Error("登录凭据密钥无法打开。");
        return xorKey(Buffer.from(opened, "hex"), mask);
      }
      return key;
    })().catch((error) => {
      cached = undefined;
      throw error;
    }));
  return {
    async seal(plain) {
      if (readOnly) throw new Error("只读凭据检查不能保存秘密。");
      return aesSecretBox(await keyPromise(true)).seal(plain);
    },
    async open(sealed) {
      return aesSecretBox(await keyPromise(false)).open(sealed);
    },
  };
}

/** The caller owns an offline lease and a disposable copy of the crypt profile.
 * The original path still supplies the directory mask; no key or marker is written. */
export function existingSecretBox(
  directory: string,
  scratch: string,
): SecretBox {
  if (
    existsSync(join(directory, "os-crypt.key")) ||
    (process.platform === "linux" &&
      !/^[a-f0-9]{64}$/i.test(process.env.ASTER_CLOUD_SECRET_KEY ?? ""))
  )
    return safeStorageSecretBox(
      directory,
      (_directory, mode, payload, plain) =>
        process.platform === "linux"
          ? linuxKeyringCrypt(directory, mode, payload, () =>
              electronCrypt(scratch, mode, payload, plain, true),
            )
          : isDpapiWrapper(payload)
            ? systemCrypt(directory, mode, payload, plain)
            : electronCrypt(scratch, mode, payload, plain, true),
      true,
    );
  return defaultSecretBox(directory);
}

/** Explicit offline rewrap preserves the AES key, sealed data and device trust.
 * A weak backend is used only to read the old key, never to write its replacement. */
export async function migrateSafeStorageKey(directory: string) {
  const path = join(directory, "os-crypt.key");
  const existing = await readFile(path);
  let plain: Buffer;
  try {
    plain =
      process.platform === "linux"
        ? await linuxKeyringCrypt(directory, "open", existing, () =>
            electronCrypt(directory, "open", existing, false, true),
          )
        : isDpapiWrapper(existing)
          ? await systemCrypt(directory, "open", existing, false)
          : await electronCrypt(directory, "open", existing, false, true);
  } catch (error) {
    if (isDpapiWrapper(existing)) throw error;
    plain =
      process.platform === "linux"
        ? await linuxKeyringCrypt(directory, "open", existing, () =>
            electronCrypt(directory, "open", existing, true, false),
          )
        : await electronCrypt(directory, "open", existing, true, false);
  }
  if (!/^[a-f0-9]{64}$/i.test(plain.toString("utf8").trim()))
    throw new Error("旧密钥无法校验，未改写凭据。");
  const sealed = await systemCrypt(directory, "seal", plain, false);
  const temporary = join(directory, `.os-crypt.${randomUUID()}.migrate`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(sealed);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    // If this marker write fails, rerun this explicit command. Strong opening
    // is attempted first and does not depend on the old backend marker.
    await writeFile(join(directory, "os-crypt.backend"), "os", { mode: 0o600 });
  } finally {
    await rm(temporary, { force: true });
  }
}

export function defaultSecretBox(directory: string): SecretBox {
  if (existsSync(join(directory, "os-crypt.key")))
    return safeStorageSecretBox(directory, systemCrypt);
  if (process.platform === "win32") return dpapiSecretBox();
  if (process.platform === "linux") {
    const hex = process.env.ASTER_CLOUD_SECRET_KEY ?? "";
    if (/^[a-f0-9]{64}$/i.test(hex))
      return aesSecretBox(Buffer.from(hex, "hex"));
    return safeStorageSecretBox(directory, systemCrypt);
  }
  return {
    async seal() {
      throw new Error("云端登录凭据需要系统保护，当前环境未启用。");
    },
    async open() {
      throw new Error("云端登录凭据需要系统保护，当前环境未启用。");
    },
  };
}

export async function relocateSecretKey(
  source: string,
  staging: string,
  destination: string,
) {
  const wrapped = await readFile(join(source, "os-crypt.key"));
  const opened = (await protectKey(source, "open", wrapped, systemCrypt, true))
    .toString("utf8")
    .trim();
  if (!/^[a-f0-9]{64}$/i.test(opened))
    throw new Error("旧工作区凭据密钥无法打开，原始数据与备份已保留。");
  const key = xorKey(Buffer.from(opened, "hex"), await directoryMask(source));
  const finalPath = join(
    await realpath(dirname(destination)),
    basename(destination),
  );
  const mask = createHash("sha256").update(finalPath.toLowerCase()).digest();
  const crypt: OsCrypt = (directory, mode, payload, plain) =>
    process.platform === "linux"
      ? linuxKeyringCrypt(
          directory,
          mode,
          payload,
          () => electronCrypt(directory, mode, payload, plain),
          finalPath,
        )
      : systemCrypt(directory, mode, payload, plain);
  const sealed = await protectKey(
    staging,
    "seal",
    Buffer.from(xorKey(key, mask).toString("hex"), "utf8"),
    crypt,
  );
  await writeFile(join(staging, "os-crypt.key"), sealed, { mode: 0o600 });
}
