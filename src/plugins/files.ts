import { lstat, opendir, realpath, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, dirname } from "node:path";
import { readGrantedBytes } from "../files/read.js";
import { AppError } from "../shared/core.js";

export function pluginPath(root: string, path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    /[\u0000-\u001f:]/.test(path) ||
    path.split("/").some((part) => part === ".." || part === "." || !part)
  )
    throw new AppError("invalid_input", "插件包含无效的相对路径。");
  const target = resolve(root, path);
  if (!relative(root, target) || relative(root, target).startsWith(`..${sep}`))
    throw new AppError("invalid_input", "插件路径超出目录。");
  return target;
}

/** Capture an immutable, bounded package; never follow source symlinks. */
export async function capturePlugin(root: string, signal: AbortSignal) {
  if (
    !isAbsolute(root) ||
    !(await lstat(root)).isDirectory() ||
    (await lstat(root)).isSymbolicLink()
  )
    throw new AppError("invalid_input", "请选择插件目录，不能使用符号链接。");
  const canonical = await realpath(root),
    files: Record<string, string> = {};
  let size = 0,
    entries = 0;
  const walk = async (directory: string, prefix: string, depth: number) => {
    signal.throwIfAborted();
    if (depth > 16) throw new AppError("capacity", "插件目录层级超过 16 层。");
    for await (const entry of await opendir(directory)) {
      signal.throwIfAborted();
      if ([".git", "node_modules"].includes(entry.name)) continue;
      if (++entries > 1024)
        throw new AppError("capacity", "插件目录内容过多。");
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = pluginPath(canonical, path),
        info = await lstat(target);
      if (info.isSymbolicLink() || (await realpath(target)) !== target)
        throw new AppError("invalid_input", "插件不能包含符号链接。");
      if (info.isDirectory()) await walk(target, path, depth + 1);
      else if (info.isFile()) {
        if (Object.keys(files).length >= 512 || info.size > 2 * 1024 * 1024)
          throw new AppError(
            "capacity",
            "插件最多 512 个文件，单文件最多 2 MiB。",
          );
        const bytes = await readGrantedBytes(canonical, path, signal);
        if (bytes.length > 2 * 1024 * 1024)
          throw new AppError("capacity", "插件单文件最多 2 MiB。");
        size += bytes.length;
        if (size > 8 * 1024 * 1024)
          throw new AppError("capacity", "插件内容超过 8 MiB。");
        files[path] = bytes.toString("base64");
      } else throw new AppError("invalid_input", "插件包含非常规文件。");
    }
  };
  await walk(canonical, "", 0);
  return files;
}

export async function materializePlugin(
  root: string,
  files: Record<string, string>,
  signal: AbortSignal,
) {
  for (const [path, data] of Object.entries(files)) {
    signal.throwIfAborted();
    const target = pluginPath(root, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, Buffer.from(data, "base64"), {
      mode: 0o700,
      signal,
      flag: "wx",
    });
  }
}
