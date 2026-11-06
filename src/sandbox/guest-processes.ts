import type { Sandbox } from "microsandbox";

// All script processes use this VM's dedicated UID 1000. Unlike a process-group
// kill, this also finds daemonized/setsid descendants before the next command.
const cleanup = `import os, signal, time
me = os.getpid()
deadline = time.monotonic() + 1
while True:
    remaining = []
    for entry in os.scandir('/proc'):
        if not entry.name.isdigit() or int(entry.name) == me:
            continue
        try:
            if entry.stat().st_uid == 1000 and open(entry.path + '/stat').read().split(') ', 1)[1][0] != 'Z':
                remaining.append(int(entry.name))
        except FileNotFoundError:
            continue
    if not remaining:
        break
    for pid in remaining:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if time.monotonic() >= deadline:
        raise RuntimeError('script descendants did not stop')
    time.sleep(0.01)
`;
export async function drainScriptProcesses(sandbox: Sandbox) {
  const result = await sandbox.execWith("python3", (b) =>
    b.args(["-c", cleanup]).timeout(2000),
  );
  if (!result.success)
    throw new Error("脚本子进程清理失败；必须停止所属虚拟机。");
}
