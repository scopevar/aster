import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aster-dev-command-"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "dist", "desktop"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await copyFile("scripts/dev.mjs", join(root, "scripts", "dev.mjs"));
  await copyFile(
    "scripts/project-env.mjs",
    join(root, "scripts", "project-env.mjs"),
  );
  await copyFile(
    "scripts/dev-process.mjs",
    join(root, "scripts", "dev-process.mjs"),
  );
  // Isolate lifecycle checks from the host's display, libraries and Electron.
  await writeFile(
    join(root, "scripts", "dev-environment.mjs"),
    "export async function inspectDevEnvironment(root, options) { if(options.installElectron !== !process.argv.includes('--doctor') || !options.signal) throw Error('Incorrect Electron installation options'); return true; }",
  );
  const history = join(root, "history.txt");
  const mark = (value: string) =>
    `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(history)}, ${JSON.stringify(value + "\n")});`;
  await writeFile(
    join(root, "scripts", "dev-runtime.mjs"),
    `import {appendFileSync} from 'node:fs'; export async function maintainRuntime(root, action) { if(action==='restart') appendFileSync(${JSON.stringify(history)}, ${JSON.stringify("restart\n")}); return 0; }`,
  );
  return { root, history, mark };
}
async function run(root: string, args: string[] = []) {
  const child = spawn(process.execPath, [
    join(root, "scripts", "dev.mjs"),
    ...args,
  ]);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    output += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    output += text;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, output };
}

await test("dev builds and connects without stopping the daemon; doctor remains read-only", async () => {
  const { root, history, mark } = await fixture();
  try {
    await writeFile(join(root, "scripts", "build.mjs"), mark("build"));
    await writeFile(
      join(root, "dist", "desktop", "launcher.js"),
      mark("launch") + "process.exitCode=7;",
    );
    const doctor = await run(root, ["--doctor"]);
    assert.equal(doctor.code, 0);
    await assert.rejects(readFile(history), { code: "ENOENT" });
    for (const argument of ["--unknown", "--restart"]) {
      const invalid = await run(root, [argument]);
      assert.equal(invalid.code, 1);
      await assert.rejects(readFile(history), { code: "ENOENT" });
    }
    const launched = await run(root);
    assert.equal(launched.code, 7);
    assert.equal(await readFile(history, "utf8"), "build\nlaunch\n");
    assert.match(launched.output, /pnpm dev --doctor/);
    await rm(history);
    const restarted = await run(root);
    assert.equal(restarted.code, 7);
    assert.equal(await readFile(history, "utf8"), "build\nlaunch\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("Ctrl+C during a dev build waits for its child and never starts the desktop", async () => {
  const { root, history, mark } = await fixture();
  await writeFile(
    join(root, "scripts", "build.mjs"),
    `${mark("build")} process.on('SIGTERM',()=>{setTimeout(()=>{process.exit(0)},100)});console.log('BUILD_READY');setInterval(()=>{},1000);`,
  );
  await writeFile(join(root, "dist", "desktop", "launcher.js"), mark("launch"));
  const signalBridge = join(root, "signal-bridge.mjs");
  // Windows kill(SIGINT) terminates immediately instead of delivering Ctrl+C.
  // Inject only the signal event; the real dev entry owns abort and child cleanup.
  await writeFile(
    signalBridge,
    "process.stdin.once('data', () => { process.stdin.pause(); process.emit('SIGINT'); });",
  );
  const parent = spawn(process.execPath, [
    ...(process.platform === "win32"
      ? ["--import", pathToFileURL(signalBridge).href]
      : []),
    join(root, "scripts", "dev.mjs"),
  ]);
  const exited = once(parent, "exit");
  try {
    await new Promise<void>((resolve) =>
      parent.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("BUILD_READY")) resolve();
      }),
    );
    if (process.platform === "win32") parent.stdin.end("interrupt");
    else parent.kill("SIGINT");
    const [code, signal] = await exited;
    assert.equal(code, 130);
    assert.equal(signal, null);
    assert.equal(await readFile(history, "utf8"), "build\n");
  } finally {
    if (parent.exitCode === null && parent.signalCode === null)
      parent.kill("SIGTERM");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});

await test("a failed dev build cannot launch an existing stale desktop", async () => {
  const { root, history, mark } = await fixture();
  try {
    await writeFile(
      join(root, "scripts", "build.mjs"),
      mark("build-failed") + "process.exitCode=3;",
    );
    await writeFile(
      join(root, "dist", "desktop", "launcher.js"),
      mark("stale-desktop"),
    );
    const result = await run(root);
    assert.equal(result.code, 3);
    assert.equal(await readFile(history, "utf8"), "build-failed\n");
    assert.match(result.output, /构建失败，未启动旧程序/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("dev refuses to build or launch when read-only daemon preflight fails", async () => {
  const { root, history, mark } = await fixture();
  try {
    await writeFile(join(root, "scripts", "build.mjs"), mark("build"));
    await writeFile(
      join(root, "dist", "desktop", "launcher.js"),
      mark("launch"),
    );
    await writeFile(
      join(root, "scripts", "dev-runtime.mjs"),
      "export async function maintainRuntime() { console.error('旧系统尚未退出'); return 2; }",
    );
    const result = await run(root);
    assert.equal(result.code, 2);
    assert.match(result.output, /旧系统尚未退出/);
    await assert.rejects(readFile(history), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("a failed controller build does not stop the daemon or launch stale code", async () => {
  const { root, history, mark } = await fixture();
  try {
    await writeFile(
      join(root, "scripts", "build.mjs"),
      mark("build-failed") + "process.exitCode=3;",
    );
    await writeFile(
      join(root, "dist", "desktop", "launcher.js"),
      mark("launch"),
    );
    const result = await run(root);
    assert.equal(result.code, 3);
    assert.equal(await readFile(history, "utf8"), "build-failed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("unverified worker ownership blocks startup and doctor cannot report success", async () => {
  const { root, history, mark } = await fixture();
  try {
    await writeFile(join(root, "scripts", "build.mjs"), mark("build"));
    await writeFile(
      join(root, "dist", "desktop", "launcher.js"),
      mark("launch"),
    );
    await writeFile(
      join(root, "scripts", "dev-runtime.mjs"),
      "export async function maintainRuntime() { console.error('后台身份无法确认，请执行 pnpm dev --doctor'); return 2; }",
    );
    for (const args of [[], ["--doctor"]]) {
      const result = await run(root, args);
      assert.equal(result.code, 2);
      assert.match(result.output, /后台身份无法确认/);
      assert.doesNotMatch(result.output, /检查通过/);
      await assert.rejects(readFile(history), { code: "ENOENT" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
