import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const packages = {
  "libnss3.so": "libnss3",
  "libnssutil3.so": "libnss3",
  "libsmime3.so": "libnss3",
  "libnspr4.so": "libnspr4",
  "libatk-1.0.so.0": "libatk1.0-0",
  "libatk-bridge-2.0.so.0": "libatk-bridge2.0-0",
  "libcups.so.2": "libcups2",
  "libgtk-3.so.0": "libgtk-3-0",
  "libasound.so.2": "libasound2",
  "libgbm.so.1": "libgbm1",
  "libX11.so.6": "libx11-6",
  "libXcomposite.so.1": "libxcomposite1",
  "libXdamage.so.1": "libxdamage1",
  "libXrandr.so.2": "libxrandr2",
  "libXfixes.so.3": "libxfixes3",
  "libxkbcommon.so.0": "libxkbcommon0",
  "libdbus-1.so.3": "libdbus-1-3",
};
const time64 = new Set([
  "libatk1.0-0",
  "libatk-bridge2.0-0",
  "libcups2",
  "libgtk-3-0",
  "libasound2",
]);

export function libraryAction(missing, release) {
  const fields = Object.fromEntries(
    release.split("\n").flatMap((line) => {
      const match = /^(\w+)=["']?([^"']*)["']?$/.exec(line);
      return match ? [[match[1], match[2]]] : [];
    }),
  );
  const ids = [fields.ID, ...(fields.ID_LIKE || "").split(/\s+/)];
  const apt = ids.some((id) =>
    ["ubuntu", "debian", "linuxmint", "pop"].includes(id),
  );
  const version = Number(fields.VERSION_ID?.split(".")[0]);
  const newer =
    (fields.ID === "ubuntu" && version >= 24) ||
    (fields.ID === "debian" && version >= 13) ||
    (fields.ID === "linuxmint" && version >= 22) ||
    (fields.ID === "pop" && version >= 24) ||
    ["noble", "oracular", "plucky", "questing"].includes(
      fields.UBUNTU_CODENAME,
    );
  const names = missing.map((line) => line.trim().split(/\s+/)[0]);
  const known = [
    ...new Set(names.map((name) => packages[name]).filter(Boolean)),
  ];
  const selected = known.map((name) => {
    if (!apt || !time64.has(name)) return name;
    // Query local package metadata only; derivatives need not share a version number.
    const candidate = `${name}t64`;
    const info = spawnSync("apt-cache", ["show", candidate], {
      encoding: "utf8",
      timeout: 2000,
    });
    const available =
      info.status === 0 && info.stdout?.includes(`Package: ${candidate}\n`);
    return available || newer ? candidate : name;
  });
  const instructions = [];
  if (apt && selected.length)
    instructions.push(`执行 sudo apt install ${selected.join(" ")}。`);
  else if (names.length)
    instructions.push(
      `请使用当前发行版的包管理器查找并安装提供以下库的软件包：${names.join("、")}。`,
    );
  if (apt && names.some((name) => !packages[name]))
    instructions.push("未列出软件包的库请先用 apt search 查找其软件包。");
  instructions.push("安装后执行 pnpm dev --doctor，再执行 pnpm dev。");
  return instructions.join(" ");
}

export async function inspectLinuxLibraries(binary) {
  const result = spawnSync("ldd", [binary], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, LC_ALL: "C" },
  });
  const missing = (result.stdout || "")
    .split("\n")
    .filter((line) => /=>\s+not found\s*$/.test(line));
  // Positive evidence of a missing library remains a failure even if ldd exits nonzero.
  if (missing.length) {
    const release = await readFile("/etc/os-release", "utf8").catch(() => "");
    return {
      state: "missing",
      detail: missing.map((line) => line.trim()).join("；"),
      action: libraryAction(missing, release),
    };
  }
  if (result.error || result.status !== 0 || !result.stdout?.trim())
    return {
      state: "unchecked",
      detail:
        result.error?.code === "ENOENT"
          ? "未安装 ldd，系统库未检查"
          : "ldd 无法完成检查，系统库状态未知",
      action:
        "可安装提供 ldd 的软件包后执行 pnpm dev --doctor；仍可尝试 pnpm dev，若提示缺少共享库再安装对应软件包。",
    };
  return { state: "ready", detail: "动态链接库齐全", action: "" };
}
