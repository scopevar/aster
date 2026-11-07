import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  inspectDesktop,
  stopDesktop,
} from "../../src/desktop/process/desktop-instance.js";
import { startDesktopWorker as startWorker } from "../helpers/desktop-worker.js";
import { assertDesktopStopped } from "../../src/desktop/process/desktop-singleton-check.js";
import {
  inspectWorker,
  stopWorker,
} from "../../src/desktop/worker/worker-maintenance.js";

function electronPath() {
  const executable: unknown = createRequire(import.meta.url)("electron");
  if (typeof executable !== "string")
    throw new Error("Electron path unavailable");
  return executable;
}
function ownedChild(executable: string, args: string[], directory: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ASTER_DATA_DIR: directory,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, args, { cwd: resolve("."), env });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return { child, exited, output: () => output };
}
async function waitForExit(
  child: ChildProcess,
  exited: Promise<unknown[]>,
  output: () => string,
) {
  await expect
    .poll(() => child.exitCode !== null || child.signalCode !== null, {
      timeout: 15000,
      message: output(),
    })
    .toBe(true);
  return exited;
}

test("real desktop releases its singleton after restart and Ctrl+C", async () => {
  test.skip(
    process.platform !== "linux",
    "Linux singleton ownership inspection",
  );
  const directory = await mkdtemp(join(tmpdir(), "aster-desktop-lifecycle-"));
  await assertDesktopStopped(directory, electronPath());
  const worker = await startWorker(directory);
  let desktop = ownedChild(electronPath(), [resolve(".")], directory);
  try {
    await expect
      .poll(() => desktop.output(), { timeout: 15000 })
      .toContain("桌面窗口已打开");
    expect(await inspectDesktop(directory, electronPath())).toEqual({
      state: "running",
      pid: desktop.child.pid,
    });
    await expect(
      assertDesktopStopped(directory, electronPath()),
    ).rejects.toThrow("旧桌面仍在运行");
    await stopDesktop(directory, electronPath());
    expect(
      await waitForExit(desktop.child, desktop.exited, desktop.output),
    ).toEqual([0, null]);
    expect((await inspectDesktop(directory, electronPath())).state).toBe(
      "absent",
    );
    await expect(
      readlink(join(directory, "desktop", "SingletonLock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await assertDesktopStopped(directory, electronPath());
    desktop = ownedChild(electronPath(), [resolve(".")], directory);
    await expect
      .poll(() => desktop.output(), { timeout: 15000 })
      .toContain("桌面窗口已打开");
    desktop.child.kill("SIGINT");
    expect(
      await waitForExit(desktop.child, desktop.exited, desktop.output),
    ).toEqual([0, null]);
    expect((await inspectDesktop(directory, electronPath())).state).toBe(
      "absent",
    );
    await expect(
      readlink(join(directory, "desktop", "SingletonLock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (desktop.child.exitCode === null && desktop.child.signalCode === null)
      desktop.child.kill("SIGKILL");
    await desktop.exited;
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Ctrl+C traverses the dev and launcher chain without leaving a desktop", async () => {
  test.skip(
    process.platform !== "linux",
    "Linux signal and singleton regression",
  );
  const directory = await mkdtemp(join(tmpdir(), "aster-dev-lifecycle-"));
  const command = ownedChild(process.execPath, ["scripts/dev.mjs"], directory);
  try {
    await expect
      .poll(
        async () => {
          if (
            command.child.exitCode !== null ||
            command.child.signalCode !== null
          )
            throw new Error(command.output());
          return (await inspectDesktop(directory, electronPath())).state;
        },
        { timeout: 60000 },
      )
      .toBe("running");
    command.child.kill("SIGINT");
    expect(
      await waitForExit(command.child, command.exited, command.output),
    ).toEqual([130, null]);
    expect((await inspectDesktop(directory, electronPath())).state).toBe(
      "absent",
    );
    await expect(
      readlink(join(directory, "desktop", "SingletonLock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await inspectWorker(directory)).state).toBe("running");
    expect(command.output()).not.toContain("桌面启动或运行失败");
  } finally {
    if (command.child.exitCode === null && command.child.signalCode === null)
      command.child.kill("SIGKILL");
    await command.exited;
    const desktop = await inspectDesktop(directory, electronPath());
    // Failure cleanup is restricted to the GUI verified in this test's private directory.
    if (desktop.state === "running") process.kill(desktop.pid, "SIGKILL");
    await stopWorker(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

test("dev doctor leaves the existing desktop and local daemon untouched", async () => {
  test.skip(
    process.platform !== "linux",
    "Linux singleton and signal inspection",
  );
  const directory = await mkdtemp(join(tmpdir(), "aster-doctor-lifecycle-"));
  const worker = await startWorker(directory);
  const original = ownedChild(electronPath(), [resolve(".")], directory);
  let command: ReturnType<typeof ownedChild> | undefined;
  try {
    await expect
      .poll(() => original.output(), { timeout: 15000 })
      .toContain("桌面窗口已打开");
    const before = await inspectDesktop(directory, electronPath());
    command = ownedChild(
      process.execPath,
      ["scripts/dev.mjs", "--doctor"],
      directory,
    );
    expect(
      await waitForExit(command.child, command.exited, command.output),
    ).toEqual([0, null]);
    expect(command.output()).toContain("不会停止或重复启动");
    expect(command.output()).not.toContain("正在准备源码");
    expect(await inspectDesktop(directory, electronPath())).toEqual(before);
    expect(original.child.exitCode).toBeNull();
    const backend = await inspectWorker(directory);
    expect(backend.state).toBe("running");
    if (backend.state === "running")
      expect(backend.endpoint.pid).toBe(worker.endpoint.pid);
  } finally {
    if (
      command &&
      command.child.exitCode === null &&
      command.child.signalCode === null
    )
      command.child.kill("SIGKILL");
    await command?.exited;
    await stopDesktop(directory, electronPath());
    await original.exited;
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
