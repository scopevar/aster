import { readFile, readlink, realpath, readdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type DesktopInspection =
  | { state: "absent" | "unsupported" }
  | { state: "running"; pid: number }
  | { state: "unverified"; message: string };
function recoveryHint(directory: string) {
  const lock = join(directory, "desktop", "SingletonLock");
  const quoted = "'" + lock.replaceAll("'", "'\\''") + "'";
  return `请先关闭使用此数据目录的桌面。若确认没有桌面运行且此目录未由其他主机共享，可仅删除残留实例锁：rm -- ${quoted}，然后执行 pnpm dev；不要删除数据目录。`;
}
/** Bind the directory's Chromium singleton to a live process, not mutable argv. */
async function ownsDesktopSocket(directory: string, pid: number) {
  const socket = await realpath(join(directory, "desktop", "SingletonSocket"));
  if (!(await stat(socket)).isSocket()) return false;
  const [cookie, socketCookie, table, descriptors] = await Promise.all([
    readlink(join(directory, "desktop", "SingletonCookie")),
    readlink(join(dirname(socket), "SingletonCookie")),
    readFile(`/proc/${pid}/net/unix`, "utf8"),
    readdir(`/proc/${pid}/fd`),
  ]);
  if (!cookie || cookie !== socketCookie) return false;
  const inode = table
    .split("\n")
    .map((line) =>
      /^(?:\S+\s+){3}00010000\s+0001\s+\S+\s+(\d+)\s+(.+)$/.exec(line),
    )
    .find((match) => match?.[2] === socket)?.[1];
  if (!inode) return false;
  for (const fd of descriptors) {
    try {
      if ((await readlink(`/proc/${pid}/fd/${fd}`)) === `socket:[${inode}]`)
        return true;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
  return false;
}
/** Never signal a disk PID without verifying executable, UID and live socket ownership. */
export async function inspectDesktop(
  directory: string,
  executable: string,
): Promise<DesktopInspection> {
  if (process.platform !== "linux") return { state: "unsupported" };
  let lock: string;
  try {
    lock = await readlink(join(directory, "desktop", "SingletonLock"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { state: "absent" };
    return {
      state: "unverified",
      message: `无法读取桌面实例锁。${recoveryHint(directory)}`,
    };
  }
  try {
    const match = /^(.+)-(\d+)$/.exec(lock);
    if (!match || match[1] !== hostname())
      throw new Error("桌面实例锁不属于当前主机。");
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
      throw new Error("桌面实例 PID 无效。");
    let status: string, binary: string;
    try {
      [status, binary] = await Promise.all([
        readFile(`/proc/${pid}/status`, "utf8"),
        realpath(`/proc/${pid}/exe`),
      ]);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { state: "absent" };
      throw error;
    }
    const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    if (Number(uid) !== process.getuid?.())
      throw new Error(
        `桌面进程 ${pid} 不属于当前用户。请使用启动原桌面的用户关闭它后再执行 pnpm dev。`,
      );
    if (binary !== (await realpath(executable)))
      throw new Error(
        `桌面进程 ${pid} 的程序与当前 Electron 不同（可能已升级依赖）。请从旧托盘退出原桌面，再执行 pnpm dev。`,
      );
    if (!(await ownsDesktopSocket(directory, pid)))
      throw new Error(
        `桌面进程 ${pid} 未持有此数据目录的实例套接字，身份无法确认；未终止该进程。请关闭旧桌面，再执行 pnpm dev。`,
      );
    return { state: "running", pid };
  } catch (error) {
    return {
      state: "unverified",
      message: `${error instanceof Error ? error.message : "桌面实例无法确认。"} ${recoveryHint(directory)}`,
    };
  }
}
export async function stopDesktop(directory: string, executable: string) {
  const current = await inspectDesktop(directory, executable);
  if (current.state === "unverified") throw new Error(current.message);
  if (current.state !== "running") return;
  // Recheck immediately before signalling; PID files alone never authorize a stop.
  const checked = await inspectDesktop(directory, executable);
  if (checked.state === "absent") return;
  if (checked.state !== "running" || checked.pid !== current.pid)
    throw new Error("桌面实例在停止前发生变化，请重新运行 pnpm dev --doctor。");
  console.info(`正在退出本项目的旧桌面进程 ${checked.pid}。`);
  try {
    process.kill(checked.pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
    // It may exit after verification; still inspect the directory for a replacement below.
  }
  const deadline = Date.now() + 10000;
  do {
    await delay(100);
    const next = await inspectDesktop(directory, executable);
    if (next.state === "absent") return;
    if (next.state === "running" && next.pid !== checked.pid)
      throw new Error("桌面进程身份改变，停止结果需要核实。");
  } while (Date.now() < deadline);
  throw new Error(
    "旧桌面未在十秒内退出；请关闭旧窗口后再执行 pnpm dev，未强杀进程。",
  );
}
