import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DirectoryLeaseBusy,
  ownDirectory,
} from "../src/platform/directory-lease.js";

// This lease backs worker/supervisor single-instance enforcement (see
// src/worker/server.ts and src/worker/supervisor.ts). Windows uses a named
// pipe; these tests exercise whatever the current platform implements
// (Linux uses an abstract Unix domain socket) and skip on platforms that
// throw by design (see leaseAddress in directory-lease.ts).

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "aster-lease-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await test("ownDirectory rejects a second lease on the same directory", async (t) => {
  await withTempDir(async (directory) => {
    let ownership;
    try {
      ownership = await ownDirectory(directory, "worker");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("需要 Windows 或 Linux")
      ) {
        t.skip(`platform ${process.platform} has no lease implementation`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => ownDirectory(directory, "worker"),
      DirectoryLeaseBusy,
    );
    await ownership.close();
  });
});

await test("ownDirectory allows re-acquiring the lease after close", async (t) => {
  await withTempDir(async (directory) => {
    let first;
    try {
      first = await ownDirectory(directory, "worker");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("需要 Windows 或 Linux")
      ) {
        t.skip(`platform ${process.platform} has no lease implementation`);
        return;
      }
      throw error;
    }
    await first.close();
    const second = await ownDirectory(directory, "worker");
    await second.close();
  });
});

await test("ownDirectory does not conflict across distinct directories or services", async (t) => {
  await withTempDir(async (directoryA) => {
    await withTempDir(async (directoryB) => {
      let leaseA;
      try {
        leaseA = await ownDirectory(directoryA, "worker");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("需要 Windows 或 Linux")
        ) {
          t.skip(`platform ${process.platform} has no lease implementation`);
          return;
        }
        throw error;
      }
      const leaseB = await ownDirectory(directoryB, "worker");
      const leaseSupervisor = await ownDirectory(directoryA, "supervisor");
      await Promise.all([
        leaseA.close(),
        leaseB.close(),
        leaseSupervisor.close(),
      ]);
    });
  });
});

await test(
  "ownDirectory keeps case-sensitive Linux directories distinct",
  { skip: process.platform !== "linux" },
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "aster-lease-case-"));
    const upper = join(parent, "Foo");
    const lower = join(parent, "foo");
    await mkdir(upper);
    await mkdir(lower);
    const first = await ownDirectory(upper, "worker");
    try {
      const second = await ownDirectory(lower, "worker");
      await second.close();
    } finally {
      await first.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);
