import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test, mock } from "node:test";
import {
  inspectDesktop,
  stopDesktop,
} from "../src/desktop/process/desktop-instance.js";

async function desktop() {
  const root = await mkdtemp(join(tmpdir(), "aster-desktop-instance-"));
  const directory = join(root, "data"),
    profile = join(directory, "desktop"),
    socketDirectory = join(root, "socket");
  await mkdir(profile, { recursive: true });
  await mkdir(socketDirectory);
  const socket = join(socketDirectory, "SingletonSocket");
  await symlink(socket, join(profile, "SingletonSocket"));
  await symlink("fixture-cookie", join(profile, "SingletonCookie"));
  await symlink("fixture-cookie", join(socketDirectory, "SingletonCookie"));
  await writeFile(join(root, "package.json"), '{"main":"desktop.cjs"}');
  await writeFile(
    join(root, "desktop.cjs"),
    `require('node:net').createServer().listen(${JSON.stringify(socket)},()=>{process.title='aster';console.log('ready');});`,
  );
  const child = spawn(process.execPath, ["--no-warnings", root]);
  const exited = once(child, "exit");
  await once(child.stdout, "data");
  assert.ok(child.pid);
  const lock = join(profile, "SingletonLock");
  await symlink(`${hostname()}-${child.pid}`, lock);
  return {
    root,
    directory,
    child,
    exited,
    lock,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await exited;
      await rm(root, { recursive: true, force: true });
    },
  };
}

await test(
  "restart recognizes socket ownership despite rewritten argv and refuses a PID from another desktop",
  { skip: process.platform !== "linux" },
  async () => {
    const owner = await desktop(),
      other = await desktop();
    try {
      assert.deepEqual(
        await inspectDesktop(owner.directory, process.execPath),
        { state: "running", pid: owner.child.pid },
      );
      // A stale/incorrect PID must not authorize terminating another same-executable instance.
      await rm(owner.lock);
      await symlink(`${hostname()}-${other.child.pid}`, owner.lock);
      await assert.rejects(
        stopDesktop(owner.directory, process.execPath),
        /实例套接字/,
      );
      assert.equal(other.child.kill(0), true);
      assert.equal(owner.child.kill(0), true);
      await rm(owner.lock);
      await symlink(`${hostname()}-${owner.child.pid}`, owner.lock);
      const cookie = join(owner.directory, "desktop", "SingletonCookie");
      await rm(cookie);
      await symlink("mismatched-cookie", cookie);
      await assert.rejects(
        stopDesktop(owner.directory, process.execPath),
        /实例套接字/,
      );
      assert.equal(owner.child.kill(0), true);
      await rm(cookie);
      await symlink("fixture-cookie", cookie);
      await stopDesktop(owner.directory, process.execPath);
      const [code, signal] = await owner.exited;
      assert.equal(code, null);
      assert.equal(signal, "SIGTERM");
      assert.equal(
        (await inspectDesktop(owner.directory, process.execPath)).state,
        "absent",
      );
    } finally {
      await owner.close();
      await other.close();
    }
  },
);

await test(
  "restart accepts a process exiting at signal delivery but preserves other signal errors",
  { skip: process.platform !== "linux" },
  async () => {
    const owner = await desktop();
    const kill = process.kill.bind(process);
    try {
      const denied = mock.method(
        process,
        "kill",
        (pid: number, signal?: NodeJS.Signals | number) => {
          if (pid === owner.child.pid && signal === "SIGTERM")
            throw Object.assign(new Error("permission denied"), {
              code: "EPERM",
            });
          return kill(pid, signal);
        },
      );
      await assert.rejects(stopDesktop(owner.directory, process.execPath), {
        code: "EPERM",
      });
      denied.mock.restore();
      const raced = mock.method(
        process,
        "kill",
        (pid: number, signal?: NodeJS.Signals | number) => {
          if (pid === owner.child.pid && signal === "SIGTERM") {
            kill(pid, signal);
            throw Object.assign(new Error("process already exited"), {
              code: "ESRCH",
            });
          }
          return kill(pid, signal);
        },
      );
      await stopDesktop(owner.directory, process.execPath);
      raced.mock.restore();
      await owner.exited;
      assert.equal(
        (await inspectDesktop(owner.directory, process.execPath)).state,
        "absent",
      );
    } finally {
      mock.restoreAll();
      await owner.close();
    }
  },
);
