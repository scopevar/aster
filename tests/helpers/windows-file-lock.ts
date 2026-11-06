import { spawn } from "node:child_process";

export async function lockFile(path: string, releaseAfterMs: number) {
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$f=[IO.File]::Open($env:ASTER_LOCK_TEST_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { [Console]::WriteLine('LOCKED'); [Console]::Out.Flush(); if ([int]$env:ASTER_LOCK_TEST_MS -gt 0) { Start-Sleep -Milliseconds ([int]$env:ASTER_LOCK_TEST_MS) } else { [Console]::ReadLine() | Out-Null } } finally { $f.Dispose() }",
    ],
    {
      windowsHide: true,
      timeout: 15000,
      env: {
        ...process.env,
        ASTER_LOCK_TEST_FILE: path,
        ASTER_LOCK_TEST_MS: String(releaseAfterMs),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4096);
  });
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(diagnostics || `lock child exited ${code}`)),
    );
  });
  void finished.catch(() => {});
  await Promise.race([
    new Promise<void>((resolve) => {
      child.stdout.once("data", () => resolve());
    }),
    finished.then(() => {
      throw Error("lock exited before ready");
    }),
  ]);
  return {
    close: async () => {
      if (child.exitCode === null) child.stdin.end("release\n");
      await finished;
    },
  };
}
