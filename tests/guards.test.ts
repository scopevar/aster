import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ESLint } from "eslint";
import {
  collectModuleCycles,
  collectRuntimeCycles,
  findCycles,
  findCyclesFromGraph,
  main as architectureMain,
} from "../scripts/check-architecture.mjs";
import { checkAgents } from "../scripts/check-agents-md.mjs";
import {
  checkFileSizes,
  countLines,
  main as fileSizeMain,
} from "../scripts/check-file-size.mjs";

function packageFixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "aster-package-guards-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "packages", "cli", "src"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function createUiLayerLinter() {
  // lintText 使用内存源码，不能让 CI 单次运行优化改读磁盘文件。
  return new ESLint({
    overrideConfig: {
      languageOptions: {
        parserOptions: { disallowAutomaticSingleRunInference: true },
      },
    },
  });
}

void test("CLI 源码参与行数预算检查", (t) => {
  const root = packageFixture(t);
  writeFileSync(
    path.join(root, "packages/cli/src/oversized.ts"),
    contentLines(501),
  );
  const { violations } = checkFileSizes(root);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.file, "packages/cli/src/oversized.ts");
});

void test("CLI 源码参与真实导入环检测", (t) => {
  const root = packageFixture(t);
  writeFileSync(
    path.join(root, "packages/cli/src/a.ts"),
    'import { b } from "./b.js"; export const a = b;',
  );
  writeFileSync(
    path.join(root, "packages/cli/src/b.ts"),
    'import { a } from "./a.js"; export const b = a;',
  );
  assert.equal(collectRuntimeCycles(root).length, 1);
});

void test("守卫忽略已从工作区删除的文件，仍检查未跟踪源码", (t) => {
  const root = packageFixture(t);
  const directory = path.join(root, "packages/cli/src");
  const retired = path.join(directory, "retired.ts");
  writeFileSync(retired, "export const retired = true;\n");
  execFileSync("git", ["add", "packages/cli/src/retired.ts"], { cwd: root });
  unlinkSync(retired);
  writeFileSync(
    path.join(directory, "a.ts"),
    'import { b } from "./b.js"; export const a = b;',
  );
  writeFileSync(
    path.join(directory, "b.ts"),
    'import { a } from "./a.js"; export const b = a;',
  );
  writeFileSync(path.join(directory, "oversized.ts"), contentLines(501));
  assert.equal(collectRuntimeCycles(root).length, 1);
  const sizes = checkFileSizes(root);
  assert.equal(sizes.current.has("packages/cli/src/retired.ts"), false);
  assert.deepEqual(
    sizes.violations.map((item) => item.file),
    ["packages/cli/src/oversized.ts"],
  );
});

void test("架构检查能发现相对导入环", () => {
  const cycles = findCyclesFromGraph(
    new Map([
      ["/repo/src/a.ts", ["/repo/src/b.ts"]],
      ["/repo/src/b.ts", ["/repo/src/a.ts"]],
      ["/repo/src/c.ts", []],
    ]),
  );
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0], [
    "/repo/src/a.ts",
    "/repo/src/b.ts",
    "/repo/src/a.ts",
  ]);
});

void test("架构检查允许单向依赖", () => {
  const cycles = findCyclesFromGraph(
    new Map([
      ["/repo/src/a.ts", ["/repo/src/b.ts"]],
      ["/repo/src/b.ts", ["/repo/src/c.ts"]],
      ["/repo/src/c.ts", []],
    ]),
  );
  assert.deepEqual(cycles, []);
});

void test("UI 分层拦截业务反向依赖和公共层向上依赖", async () => {
  const eslint = createUiLayerLinter();
  for (const [filePath, specifier] of [
    ["src/ui/features/templates/templates.tsx", "../../app/app-view.js"],
    ["src/ui/components/modal.tsx", "../app/app-view.js"],
    ["src/ui/components/modal.tsx", "../features/templates/templates.js"],
    ["src/ui/lib/client.ts", "../app/app-view.js"],
    ["src/ui/lib/client.ts", "../features/templates/templates.js"],
    ["src/ui/lib/client.ts", "../components/modal.js"],
  ] as const) {
    const [result] = await eslint.lintText(`import "${specifier}";\n`, {
      filePath,
    });
    assert.ok(result);
    assert.deepEqual(
      result.messages.map((message) => message.ruleId),
      ["no-restricted-imports"],
      `${filePath} -> ${specifier}`,
    );
  }
});

void test("UI 分层允许应用组合、公共能力复用和直接跨功能导入", async () => {
  const eslint = createUiLayerLinter();
  for (const [filePath, specifier] of [
    ["src/ui/app/app-view.tsx", "../features/templates/templates.js"],
    ["src/ui/features/templates/templates.tsx", "../../components/modal.js"],
    ["src/ui/features/templates/templates.tsx", "../../lib/client.js"],
    ["src/ui/features/templates/templates.tsx", "../skills/skills.js"],
    ["src/ui/components/modal.tsx", "../lib/client.js"],
    ["src/ui/components/modal.tsx", "./icons.js"],
    ["src/ui/lib/client.ts", "../../shared/core.js"],
  ] as const) {
    const [result] = await eslint.lintText(`import "${specifier}";\n`, {
      filePath,
    });
    assert.ok(result);
    assert.deepEqual(result.messages, [], `${filePath} -> ${specifier}`);
  }
});

void test("架构检查解析 ESM 导入并使用跨平台路径匹配 CRLF baseline", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "aster-arch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "src", "a.ts"),
    'import { b } from "./b.js";\nexport const a = b;\n',
  );
  writeFileSync(
    path.join(root, "src", "b.ts"),
    'import { a } from "./a.js";\nexport const b = a;\n',
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "src/a.ts", "src/b.ts"], { cwd: root });
  const cycles: string[] = findCycles(root);
  assert.equal(cycles.length, 1);
  assert.match(cycles[0] ?? "", /^src\/a\.ts -> src\/b\.ts -> src\/a\.ts$/);
  mkdirSync(path.join(root, "config"));
  writeFileSync(
    path.join(root, "config", "architecture-cycles-baseline.txt"),
    cycles[0] + "\r\n",
  );
  assert.equal(architectureMain(root, []), 0);
});

void test("架构检查在遍历前排除类型导入和类型再导出", (t) => {
  const root = packageFixture(t);
  const directory = path.join(root, "packages/cli/src");
  writeFileSync(
    path.join(directory, "b.ts"),
    'import { a } from "./a.js"; export const b = a; export type B = number;',
  );
  for (const declaration of [
    'import type { B } from "./b.js";',
    'import type B from "./b.js";',
    'import type * as B from "./b.js";',
    'import { type B } from "./b.js";',
    'export type { B } from "./b.js";',
    'export { type B } from "./b.js";',
    'export type * from "./b.js";',
  ]) {
    writeFileSync(
      path.join(directory, "a.ts"),
      declaration + " export const a = 1;",
    );
    assert.deepEqual(collectRuntimeCycles(root), [], declaration);
  }
});

void test("架构检查仍拦截混合导入、再导出和副作用导入形成的运行时环", (t) => {
  const root = packageFixture(t);
  const directory = path.join(root, "packages/cli/src");
  writeFileSync(
    path.join(directory, "b.ts"),
    'import { a } from "./a.js"; export const b = a; export type B = number;',
  );
  for (const declaration of [
    'import { b, type B } from "./b.js";',
    'import b, { type B } from "./b.js";',
    'import * as b from "./b.js";',
    'import "./b.js";',
    'import {} from "./b.js";',
    'export { b, type B } from "./b.js";',
    'export * from "./b.js";',
  ]) {
    writeFileSync(
      path.join(directory, "a.ts"),
      declaration + " export const a = 1;",
    );
    assert.deepEqual(
      collectRuntimeCycles(root),
      [
        "packages/cli/src/a.ts -> packages/cli/src/b.ts -> packages/cli/src/a.ts",
      ],
      declaration,
    );
  }
});

void test("类型路径和同目标类型导入不能遮蔽真实运行时环", (t) => {
  const root = packageFixture(t);
  const directory = path.join(root, "packages/cli/src");
  writeFileSync(
    path.join(directory, "a.ts"),
    'import type { B } from "./b.js"; import type { C } from "./c.js"; import { c } from "./c.js"; export const a = c;',
  );
  writeFileSync(
    path.join(directory, "b.ts"),
    'import { c } from "./c.js"; export type B = typeof c;',
  );
  writeFileSync(
    path.join(directory, "c.ts"),
    'import { a } from "./a.js"; export const c = a; export type C = number;',
  );
  assert.deepEqual(collectRuntimeCycles(root), [
    "packages/cli/src/a.ts -> packages/cli/src/c.ts -> packages/cli/src/a.ts",
  ]);
});

function moduleFixture(t: TestContext, files: Record<string, string>) {
  const root = packageFixture(t);
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
  mkdirSync(path.join(root, "config"));
  writeFileSync(
    path.join(root, "config", "architecture-cycles-baseline.txt"),
    "",
  );
  return root;
}

void test("架构检查拒绝文件间无环但目录间互相依赖的运行时导入", (t) => {
  const root = moduleFixture(t, {
    "src/worker/server.ts":
      'import { fleet } from "../controller/fleet.js"; export const server = fleet;',
    "src/worker/endpoint.ts": "export const port = 1;",
    "src/controller/fleet.ts": "export const fleet = 1;",
    "src/controller/server.ts":
      'import { port } from "../worker/endpoint.js"; export const controller = port;',
  });
  assert.deepEqual(collectRuntimeCycles(root), []);
  assert.deepEqual(collectModuleCycles(root), [
    "src/controller -> src/worker [src/controller/server.ts -> src/worker/endpoint.ts]; src/worker -> src/controller [src/worker/server.ts -> src/controller/fleet.ts]",
  ]);
  assert.equal(architectureMain(root, []), 1);
});

void test("目录级检查允许单向依赖和类型反向引用", (t) => {
  const root = moduleFixture(t, {
    "src/worker/server.ts":
      'import { fleet } from "../controller/fleet.js"; export const server = fleet;',
    "src/worker/endpoint.ts": "export type Endpoint = { port: number };",
    "src/controller/fleet.ts":
      'import type { Endpoint } from "../worker/endpoint.js"; export const fleet = 1; export type F = Endpoint;',
    "packages/cli/src/main.ts":
      'import { server } from "../../../src/worker/server.js"; export const main = server;',
  });
  assert.deepEqual(collectModuleCycles(root), []);
  assert.equal(architectureMain(root, []), 0);
});

void test("行数统计忽略末尾换行产生的空行", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aster-size-"));
  writeFileSync(path.join(root, "one.ts"), "const a = 1;\n");
  assert.equal(countLines(path.join(root, "one.ts")), 1);
});

void test("行数 ratchet 拒绝新文件超过预算", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aster-size-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "new.ts"), contentLines(501));
  const { violations } = checkFileSizes(root, new Map(), ["src/new.ts"]);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.file, /src\/new\.ts$/);
});

void test("行数 ratchet 允许老文件保持 baseline", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aster-size-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "legacy.ts"), contentLines(700));
  const { violations } = checkFileSizes(
    root,
    new Map([["src/legacy.ts", 700]]),
    ["src/legacy.ts"],
  );
  assert.deepEqual(violations, []);
});

void test("行数 ratchet 拒绝老文件在 baseline 上继续增长", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aster-size-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "legacy.ts"), contentLines(701));
  const { violations } = checkFileSizes(
    root,
    new Map([["src/legacy.ts", 700]]),
    ["src/legacy.ts"],
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.reason, "grew");
});

void test("AGENTS 大小检查拒绝超限文件", (t) => {
  const root = packageFixture(t);
  writeFileSync(path.join(root, "AGENTS.md"), "x".repeat(12_001));
  const problems = checkAgents(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /exceeds 12000/);
});

void test("AGENTS 检查拒绝缺少规则文件的仓库", (t) => {
  const root = packageFixture(t);
  const problems = checkAgents(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /No AGENTS\.md files found/);
});

void test("AGENTS 检查允许仅有规则文件和持久化改动的仓库", (t) => {
  const root = packageFixture(t);
  writeFileSync(path.join(root, "AGENTS.md"), "# 工作规则\n");
  mkdirSync(path.join(root, "src/storage"), { recursive: true });
  writeFileSync(path.join(root, "src/storage/store.ts"), "export {};\n");
  assert.deepEqual(checkAgents(root), []);
});

function contentLines(count: number) {
  return (
    Array.from(
      { length: count },
      (_, index) => `const v${index} = ${index};`,
    ).join("\n") + "\n"
  );
}

void test("架构检查拒绝把新增环写进 baseline", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aster-arch-"));
  mkdirSync(path.join(root, "config"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "config", "architecture-cycles-baseline.txt"),
    "",
  );
  writeFileSync(
    path.join(root, "src", "a.ts"),
    'import { b } from "./b.js";\nexport const a = b;\n',
  );
  writeFileSync(
    path.join(root, "src", "b.ts"),
    'import { a } from "./a.js";\nexport const b = a;\n',
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "src/a.ts", "src/b.ts"], { cwd: root });
  assert.equal(architectureMain(root, ["--write-baseline"]), 1);
  assert.equal(
    readFileSync(
      path.join(root, "config", "architecture-cycles-baseline.txt"),
      "utf8",
    ),
    "",
  );
});

void test("行数 ratchet 拒绝把增长写进 baseline", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aster-size-"));
  mkdirSync(path.join(root, "config"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "legacy.ts"), contentLines(701));
  writeFileSync(
    path.join(root, "config", "file-size-baseline.txt"),
    "src/legacy.ts\t700\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "src"], { cwd: root });
  assert.equal(fileSizeMain(root, ["--write-baseline"]), 1);
  assert.equal(
    readFileSync(path.join(root, "config", "file-size-baseline.txt"), "utf8"),
    "src/legacy.ts\t700\n",
  );
});

void test("已有 baseline 时拒绝重复初始化", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aster-arch-"));
  mkdirSync(path.join(root, "config"));
  writeFileSync(
    path.join(root, "config", "architecture-cycles-baseline.txt"),
    "",
  );
  assert.equal(architectureMain(root, ["--init-baseline"]), 1);
});
