import { spawn } from "node:child_process";

/** Electron must not retain a libuv ChildProcess handle for the daemon on
 * Windows. The short-lived OS launcher exits before readiness is returned. */
export async function launchWindowsDaemon(
  executable: string,
  script: string,
  env: NodeJS.ProcessEnv,
) {
  const source = `$ErrorActionPreference='Stop'; $daemonArguments='"'+$env:ASTER_DAEMON_SCRIPT.Replace('"','\"')+'" run'; $daemonProcess=Start-Process -FilePath $env:ASTER_DAEMON_EXECUTABLE -ArgumentList $daemonArguments -WindowStyle Hidden -PassThru; [Console]::Out.Write($daemonProcess.Id)`;
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source],
    {
      env: {
        ...env,
        ASTER_DAEMON_EXECUTABLE: executable,
        ASTER_DAEMON_SCRIPT: script,
        ASTER_DAEMON_BACKGROUND: "1",
      },
      windowsHide: true,
      stdio: "ignore",
    },
  );
  child.unref();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error("系统启动器未确认退出，请检查 daemon 状态；未重复启动。"),
        ),
      10000,
    );
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("系统 daemon 启动器无法启动。"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("系统 daemon 启动器失败。"));
    });
  });
}
