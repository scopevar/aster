import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runDesktop } from "../src/desktop/process/desktop-process.js";

await test("desktop child drops inherited Node mode, keeps its data directory and propagates exit codes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-desktop-process-"));
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  try {
    process.env.ELECTRON_RUN_AS_NODE = "1";
    const script = join(directory, "child.cjs");
    await writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(join(directory, "capture.json"))}, JSON.stringify({mode:process.env.ELECTRON_RUN_AS_NODE ?? null,directory:process.env.ASTER_DATA_DIR})); process.exit(17);`,
    );
    assert.equal(await runDesktop(process.execPath, script, directory), 17);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "capture.json"), "utf8")),
      { mode: null, directory },
    );
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1");
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

await test(
  "a desktop killed by a signal cannot look like a successful exit",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "aster-desktop-signal-"));
    try {
      const script = join(directory, "child.cjs");
      await writeFile(script, "process.kill(process.pid, 'SIGTERM');");
      assert.equal(await runDesktop(process.execPath, script, directory), 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

await test(
  "Ctrl+C reaches the owned desktop, waits for cleanup and removes launcher listeners",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "aster-desktop-interrupt-"));
    const script = join(directory, "desktop.cjs"),
      launcher = join(directory, "launcher.mjs"),
      saved = join(directory, "saved.txt");
    await writeFile(
      script,
      `process.on('SIGTERM',()=>{setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(saved)},'saved');process.exit(0)},100);});console.log('ready');setInterval(()=>{},1000);`,
    );
    await writeFile(
      launcher,
      `import {runDesktop} from ${JSON.stringify(pathToFileURL(resolve("src/desktop/process/desktop-process.ts")).href)};const before=process.listenerCount('SIGINT');process.exitCode=await runDesktop(process.execPath,${JSON.stringify(script)},${JSON.stringify(directory)});if(process.listenerCount('SIGINT')!==before)throw Error('signal listener leaked');`,
    );
    const parent = spawn(process.execPath, ["--import", "tsx", launcher]);
    const exited = once(parent, "exit");
    try {
      await once(parent.stdout, "data");
      parent.kill("SIGINT");
      parent.kill("SIGINT");
      const [code, signal] = await exited;
      assert.equal(code, 130);
      assert.equal(signal, null);
      assert.equal(await readFile(saved, "utf8"), "saved");
    } finally {
      if (parent.exitCode === null && parent.signalCode === null)
        parent.kill("SIGTERM");
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
