import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { daemonCli } from "./helpers/daemon-cli.js";
import { piModelServer } from "./helpers/pi-model-server.js";
import { agentConnectionsStatusSchema } from "../src/shared/agent-connections.js";
import { resultSchema } from "../src/shared/core.js";
import { snapshotUpdateSchema } from "../src/shared/snapshot.js";
import { DocumentReader } from "../src/documents/reader.js";
import { daemonStatus, stopDaemon } from "../src/daemon/lifecycle.js";
import { samplePdf } from "./helpers/pdf.js";

await test(
  "tarball installation owns runtime dependencies, execution and parser resources outside the checkout",
  {
    skip:
      !process.env.ASTER_CLI_INSTALL_DIR &&
      "Requires a tarball installed outside the checkout",
  },
  async () => {
    const installed = resolve(process.env.ASTER_CLI_INSTALL_DIR!);
    const entry = createRequire(join(installed, "package.json")).resolve(
      "@aster/cli/entry",
    );
    assert.ok(
      relative(installed, await realpath(entry)).startsWith("node_modules"),
    );
    const location = relative(resolve("."), installed);
    assert.ok(isAbsolute(location) || location.startsWith(".."));
    assert.throws(() => createRequire(entry).resolve("electron"), {
      code: "MODULE_NOT_FOUND",
    });
    const directory = await mkdtemp(
      join(tmpdir(), "aster-cli-installed-data-"),
    );
    const model = await piModelServer();
    const environment = {
      NODE_PATH: "",
      ASTER_ELECTRON_BIN: "electron-must-not-be-used",
      ASTER_ELECTRON_APP: "",
      ASTER_STRICT_SECRETS: "1",
    };
    const launch = { executable: process.execPath, script: entry };
    const cli = (action: string, body?: unknown) =>
      daemonCli(directory, action, body, environment, launch);
    const parsers = new DocumentReader(
      pathToFileURL(
        join(
          installed,
          "node_modules/@aster/cli/dist/documents/office-worker.js",
        ),
      ),
    );
    try {
      const started = await cli("start");
      assert.deepEqual(await cli("start"), started);
      const config = agentConnectionsStatusSchema.parse(
        await cli("models", { action: "status" }),
      );
      await cli("models", {
        action: "save",
        revision: config.revision,
        config: {
          defaultAgent: model.connection.id,
          connections: [{ ...model.connection, auth: "stored" }],
        },
        credential: {
          provider: model.connection.provider,
          key: "installed-fixture-private-key",
        },
      });
      const sealed = await readFile(join(directory, "agent/pi-auth.sealed"));
      assert.equal(
        sealed.includes(Buffer.from("installed-fixture-private-key")),
        false,
      );
      const bot = resultSchema.parse(
        await cli("command", {
          id: randomUUID(),
          command: {
            type: "bot.create",
            name: "Installed CLI",
            description: "",
          },
        }),
      );
      assert.ok(bot.conversationId);
      await cli("models", {
        action: "assign",
        botId: bot.id,
        connectionId: model.connection.id,
      });
      const request = {
        id: randomUUID(),
        command: {
          type: "message.send",
          conversationId: bot.conversationId,
          text: "isolated package",
        },
      };
      await cli("command", request);
      await cli("command", request);
      let completed = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const view = snapshotUpdateSchema.parse(
          await cli("snapshot", { conversationId: bot.conversationId }),
        );
        if (
          view.changed &&
          view.snapshot.runs.some((run) => run.status === "failed")
        )
          assert.fail(JSON.stringify(view.snapshot.runs));
        if (
          view.changed &&
          view.snapshot.runs.some((run) => run.status === "completed")
        ) {
          assert.equal(
            view.snapshot.messages.filter((message) => message.role === "user")
              .length,
            1,
          );
          assert.ok(
            view.snapshot.messages.some((message) =>
              message.text.includes("Hello Pi"),
            ),
          );
          completed = true;
          break;
        }
        await delay(100);
      }
      assert.ok(completed);
      const table = await parsers.readOffice(
        Buffer.from("name,value\n中文,42\n"),
        "sample.csv",
        "table",
        {
          action: "table.range",
          sheet: 0,
          row: 1,
          column: 1,
          rows: 2,
          columns: 2,
        },
        AbortSignal.timeout(20000),
      );
      assert.ok(table.action === "table.range");
      assert.equal(table.cells[1]?.[0]?.value, "中文");
      assert.equal(table.cells[1]?.[1]?.value, "42");
      const legacy = await parsers.readOffice(
        await readFile(resolve("tests/fixtures/independent-formula.xls")),
        "independent-formula.xls",
        "table",
        {
          action: "table.range",
          sheet: 0,
          row: 1,
          column: 1,
          rows: 3,
          columns: 3,
        },
        AbortSignal.timeout(20000),
      );
      assert.ok(legacy.action === "table.range");
      assert.equal(legacy.cells[0]?.[0]?.value, "BIFF8_真实公式");
      assert.equal(legacy.cells[1]?.[2]?.formula, "A2+B2");
      const pdf = samplePdf("PACKAGE_TEXT", "PACKAGE_SCAN");
      await assert.rejects(
        parsers.read(
          pdf,
          { action: "text", page: 1 },
          AbortSignal.timeout(30000),
        ),
        /Python/,
      );
      await cli("stop");
      assert.equal(await daemonStatus(directory), null);
      await cli("start");
      const restored = snapshotUpdateSchema.parse(
        await cli("snapshot", { conversationId: bot.conversationId }),
      );
      assert.ok(
        restored.changed &&
          restored.snapshot.runs.some((run) => run.status === "completed"),
      );
      assert.equal(model.requests.length, 1);
      assert.equal(
        model.headers[0]?.authorization,
        "Bearer installed-fixture-private-key",
      );
      const credentials = agentConnectionsStatusSchema.parse(
        await cli("models", { action: "status" }),
      );
      assert.deepEqual(credentials.storedProviders, [
        model.connection.provider,
      ]);
      if (process.platform === "linux") {
        await cli("stop");
        const keyPath = join(directory, "agent/os-crypt.key");
        const originalKey = await readFile(keyPath);
        assert.ok(originalKey.toString().startsWith("aster-keyring-v1"));
        const offline = {
          ...environment,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(directory, "missing-secret-service")}`,
        };
        await daemonCli(directory, "start", undefined, offline, launch);
        await assert.rejects(
          daemonCli(directory, "models", { action: "status" }, offline, launch),
          /凭证库|密钥环/,
        );
        assert.deepEqual(await readFile(keyPath), originalKey);
        assert.deepEqual(
          await readFile(join(directory, "agent/pi-auth.sealed")),
          sealed,
        );
      }
    } finally {
      if (await daemonStatus(directory)) await stopDaemon(directory);
      await parsers.close();
      await model.close();
      if (process.platform === "linux") {
        const agent = await realpath(join(directory, "agent")).catch(
          () => null,
        );
        if (agent) {
          const identity = createHash("sha256").update(agent).digest("hex");
          try {
            await promisify(execFile)(
              "secret-tool",
              [
                "clear",
                "application",
                "aster",
                "purpose",
                "daemon-key",
                "directory",
                identity,
              ],
              { timeout: 10000 },
            );
          } catch (error) {
            if (
              !(error instanceof Error && "code" in error && error.code === 1)
            )
              throw error;
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
