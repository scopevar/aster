import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parsePlugin } from "../src/plugins/parser.js";
import { capturePlugin, pluginPath } from "../src/plugins/files.js";
import { substitute, pluginUrl } from "../src/plugins/connection.js";
import {
  pluginsRequestSchema,
  pluginWorkerRequestSchema,
} from "../src/shared/tools/plugins.js";
import { randomUUID } from "node:crypto";
const files = (values: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(values).map(([path, data]) => [
      path,
      Buffer.from(data).toString("base64"),
    ]),
  );
await test("Cursor and Claude manifests import skills, commands, rules, MCP and variable declarations", () => {
  for (const format of ["cursor", "claude"] as const) {
    const plugin = parsePlugin(
      files({
        [` .${format}-plugin/plugin.json`.trim()]: JSON.stringify({
          name: "calendar",
          description: "日历",
          version: "1",
          mcpServers: ["./servers.json"],
          variables: { properties: { SECRET: {} } },
        }),
        "skills/events/SKILL.md":
          "---\nname: events\ndescription: 读取日历\n---\n只读取用户指定日期。",
        "commands/today.md": "列出今天的日程。",
        "rules/safe.mdc": "---\ndescription: 安全规则\n---\n不要泄露令牌。",
        "agents/assistant.md": "子代理",
        "hooks/hook.json": "{}",
        "servers.json": JSON.stringify({
          mcpServers: {
            calendar: {
              url: "https://example.com/mcp",
              headers: { Authorization: "Bearer ${env:SECRET}" },
            },
            local: {
              command: "node",
              args: ["${CLAUDE_PLUGIN_ROOT}/server.js"],
            },
          },
        }),
      }),
    );
    assert.equal(plugin.format, format);
    assert.deepEqual(
      plugin.skills.map((skill) => skill.name),
      ["calendar:events", "calendar:today", "calendar:safe"],
    );
    assert.equal(plugin.skills[0]?.description, "读取日历");
    assert.deepEqual(plugin.variables, ["SECRET"]);
    assert.equal(Object.keys(plugin.servers).length, 2);
    assert.ok(plugin.warnings.some((warning) => warning.includes("hooks")));
    assert.ok(plugin.warnings.some((warning) => warning.includes("子代理")));
    assert.ok(plugin.warnings.some((warning) => warning.includes("规则")));
  }
});
await test("invalid components, duplicate skills, unsafe MCP URLs and command working directories are rejected", () => {
  const manifest = (extra: Record<string, unknown>) =>
    files({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "example",
        ...extra,
      }),
    });
  for (const path of ["../secret", "/etc", "a\\b"])
    assert.throws(() => parsePlugin(manifest({ skills: path })));
  assert.throws(() => parsePlugin(manifest({ skills: "missing" })), /不存在/);
  assert.throws(
    () =>
      parsePlugin({
        ...manifest({}),
        ...files({
          "skills/a/SKILL.md": "---\nname: duplicate\n---\na",
          "skills/b/SKILL.md": "---\nname: duplicate\n---\nb",
        }),
      }),
    /重复/,
  );
  assert.throws(
    () =>
      parsePlugin(
        manifest({ mcpServers: { service: { command: "node", cwd: "/etc" } } }),
      ),
    /工作目录/,
  );
  for (const url of [
    "file:///etc/passwd",
    "http://example.com",
    "https://user:pass@example.com/mcp",
    "https://example.com/#secret",
  ])
    assert.throws(() => pluginUrl(url));
  assert.equal(pluginUrl("http://127.0.0.1:3000/mcp").hostname, "127.0.0.1");
  assert.equal(
    substitute(
      "${CURSOR_PLUGIN_ROOT}/${env:FILE}",
      { FILE: "server.js" },
      "/owned",
    ),
    "/owned/server.js",
  );
  assert.throws(() => substitute("${HOME}", {}, "/owned"), /缺少插件变量/);
  assert.throws(() => pluginPath("/owned", "../outside"));
});
await test("capture rejects symlinks and oversized files and public IPC cannot accept raw paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-plugin-parser-"));
  try {
    await mkdir(join(directory, ".cursor-plugin"));
    await writeFile(
      join(directory, ".cursor-plugin", "plugin.json"),
      '{"name":"demo"}',
    );
    const signal = new AbortController().signal;
    assert.equal(
      parsePlugin(await capturePlugin(directory, signal)).name,
      "demo",
    );
    await symlink(
      process.platform === "win32"
        ? join(directory, ".cursor-plugin")
        : join(directory, ".cursor-plugin", "plugin.json"),
      join(directory, "linked"),
      process.platform === "win32" ? "junction" : "file",
    );
    await assert.rejects(capturePlugin(directory, signal), /符号链接/);
    await rm(join(directory, "linked"), { recursive: true });
    await writeFile(
      join(directory, "large"),
      Buffer.alloc(2 * 1024 * 1024 + 1),
    );
    await assert.rejects(capturePlugin(directory, signal), /单文件/);
    const request = {
      action: "prepare",
      botId: randomUUID(),
      root: directory,
      epoch: randomUUID(),
    };
    assert.equal(pluginsRequestSchema.safeParse(request).success, false);
    assert.equal(pluginWorkerRequestSchema.safeParse(request).success, true);
    assert.equal(
      pluginWorkerRequestSchema.safeParse({
        action: "prepare",
        botId: request.botId,
      }).success,
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
