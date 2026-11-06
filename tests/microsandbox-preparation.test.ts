import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SandboxResources } from "../src/sandbox/resources.js";
import { SandboxProcess } from "../src/sandbox/process.js";

// Owner: real public resource downloads, on-disk continuation, native image cache and WHP/KVM.
// No Bot VM or user command may run while the daemon is preparing immutable resources.
await test(
  "Microsandbox background preparation resumes after owner restart before creating a VM",
  {
    skip: process.env.ASTER_TEST_MICROSANDBOX !== "1",
    timeout: 900000,
  },
  async (t) => {
    const parent = resolve(".runtime/test-results");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "microsandbox-preparation-"));
    const first = new SandboxResources(root);
    const second = new SandboxResources(root);
    const vm = new SandboxProcess(new AbortController().signal, () => {});
    try {
      const waiter = new AbortController();
      let downloading: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        downloading = resolve;
      });
      first.start();
      assert.equal(first.view().state, "preparing");
      const waiting = first.wait(waiter.signal, (detail) => {
        if (/node-.*\.tar\.gz：[1-9]/.test(detail)) downloading();
      });
      await Promise.race([started, waiting]);
      waiter.abort();
      await assert.rejects(
        waiting,
        (error: Error) => error.name === "AbortError",
      );
      assert.equal(first.view().state, "preparing");
      await first.stop();
      const partial = join(root, "assets", `node-${process.arch}.tar.gz.part`);
      const previousSize = (await stat(partial)).size;
      assert.ok(
        previousSize > 0,
        "daemon stop must retain the incomplete archive",
      );
      await assert.rejects(
        access(join(root, "assets", `node-${process.arch}`)),
      );
      let resumed = false;
      const began = performance.now();
      await second.wait(AbortSignal.timeout(650000), (detail) => {
        if (
          detail.includes(
            `node-${process.arch}.tar.gz：${(previousSize / 1048576).toFixed(1)} MiB`,
          )
        )
          resumed = true;
      });
      assert.equal(
        resumed,
        true,
        "the restarted preparation must begin at persisted progress",
      );
      assert.equal(second.view().state, "ready");
      await assert.rejects(access(partial));
      const db = new DatabaseSync(join(root, "runtime", "db", "msb.db"), {
        readOnly: true,
      });
      try {
        assert.equal(
          db.prepare("SELECT count(*) AS n FROM sandbox").get()?.n,
          0,
        );
        assert.ok(
          Number(db.prepare("SELECT count(*) AS n FROM image_ref").get()?.n) >
            0,
        );
      } finally {
        db.close();
      }
      const workspace = join(root, "workspace"),
        inputs = join(root, "inputs");
      await mkdir(workspace);
      await mkdir(inputs);
      await vm.open({
        home: join(root, "runtime"),
        assets: join(root, "assets"),
        workspace,
        inputs,
        name: `aster-script-${randomUUID()}`,
        quotaMiB: 512,
        network: [],
      });
      const result = await vm.execute(
        "python3 -c \"print(6 * 7); open('answer.txt','w').write('42')\"",
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout.trim(), "42");
      assert.equal(await readFile(join(workspace, "answer.txt"), "utf8"), "42");
      t.diagnostic(
        `resumed ${previousSize} bytes; preparation ${(performance.now() - began).toFixed(0)} ms`,
      );
    } finally {
      await vm.close();
      await first.stop();
      await second.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
