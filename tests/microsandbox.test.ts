import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import * as XLSX from "xlsx";
import { AgentConnections } from "../src/agent/connections.js";
import { modelConfigPath } from "../src/agent/config-file.js";
import { resultSchema } from "../src/shared/core.js";
import { type Command } from "../src/shared/commands.js";
import { attachmentContentSchema } from "../src/shared/files/attachments.js";
import { callWorker } from "../src/worker/client.js";
import { startWorker } from "../src/worker/server.js";
import { localWorkspaceDirectory } from "../src/platform/app-data-directory.js";
import { piModelServer } from "./helpers/pi-model-server.js";
import { workerSnapshot } from "./helpers/worker-snapshot.js";
import { Store } from "../src/storage/store.js";
import { SandboxService } from "../src/sandbox/service.js";
import { SandboxProcess } from "../src/sandbox/process.js";
import { SandboxResources } from "../src/sandbox/resources.js";
import { ToolService } from "../src/tools/service.js";
import { scriptResultSchema } from "../src/shared/tools/scripts.js";
import { sandboxDocuments } from "./helpers/sandbox-documents.js";

async function seedRuntimeCache(directory: string) {
  const source = process.env.ASTER_TEST_MICROSANDBOX_CACHE;
  if (source) {
    const runtime = join(directory, "scripts", "runtime");
    await mkdir(runtime, { recursive: true });
    // Copy immutable SDK cache files; never share a live runtime or sandbox directory.
    await cp(resolve(source), join(runtime, "cache"), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  const assets = process.env.ASTER_TEST_MICROSANDBOX_ASSETS;
  if (assets)
    await cp(resolve(assets), join(directory, "scripts", "assets"), {
      recursive: true,
    });
}

// This is opt-in environment acceptance, never a mock substitute for a microVM.
// The local SSE fixture controls model choices only; Pi, MCP, Worker, SDK,
// virtual machine, uploaded XLSX bytes, approvals and downloads are all real.
await test(
  "Microsandbox: real Pi/Worker XLSX flow, isolation, cancellation, persistence and shutdown",
  {
    skip:
      process.env.ASTER_TEST_MICROSANDBOX !== "1"
        ? "set ASTER_TEST_MICROSANDBOX=1 on a WHP/KVM/Apple Silicon host"
        : false,
    timeout: 300000,
  },
  async (t) => {
    const results = resolve(".runtime/test-results");
    await mkdir(results, { recursive: true });
    const directory = await mkdtemp(join(results, "microsandbox-acceptance-"));
    const data = localWorkspaceDirectory(directory);
    await seedRuntimeCache(data);
    const home = join(directory, "agent");
    await mkdir(home);
    let operations: Array<Record<string, unknown>> = [],
      step = 0;
    const model = await piModelServer((_request, send) => {
      const operation = operations[step++];
      if (!operation) {
        send({
          role: "assistant",
          content: operations.some((op) => op.action === "export")
            ? "[calculated.xlsx](sandbox:/workspace/calculated.xlsx)"
            : "Script acceptance complete",
        });
        send({}, "stop");
        return;
      }
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `sandbox-${randomUUID()}`,
            type: "function",
            function: {
              name: operation.action === "exec" ? "shell" : "read",
              arguments: JSON.stringify(
                operation.action === "exec"
                  ? {
                      command: operation.command,
                      network: operation.network ?? [],
                    }
                  : {
                      path:
                        operation.action === "status"
                          ? "/inputs"
                          : `/workspace/${operation.path ?? ""}`,
                    },
              ),
            },
          },
        ],
      });
      send({}, "tool_calls");
    });
    await writeFile(
      modelConfigPath(home),
      JSON.stringify({
        defaultAgent: "fixture",
        connections: [model.connection],
      }),
    );
    await writeFile(
      join(home, "private-credential-fixture.txt"),
      randomBytes(32),
    );
    let worker = await startWorker(directory, { port: 0 });
    const execute = async (command: Command) =>
      resultSchema.parse(
        await callWorker(worker.endpoint, "/command", {
          id: randomUUID(),
          command,
        }),
      );
    const measurements: Array<{ name: string; durationMs: number }> = [];
    try {
      const bot = await execute({
        type: "bot.create",
        name: "MicroVM acceptance",
        description: "Use shell and read for isolated document processing.",
      });
      const other = await execute({
        type: "bot.create",
        name: "Other private Bot",
        description: "",
      });
      assert.ok(bot.id && bot.conversationId && other.id);
      const botId = bot.id,
        conversationId = bot.conversationId;
      const work = join(data, "workspaces", botId, "script-work");
      const otherWork = join(data, "workspaces", other.id, "script-work");
      await mkdir(otherWork, { recursive: true });
      await writeFile(join(otherWork, "private.txt"), randomBytes(32));
      await new AgentConnections(home).request(
        { action: "assign", botId, connectionId: "fixture" },
        AbortSignal.timeout(5000),
      );
      const inputId = randomUUID(),
        checksum = randomBytes(16).toString("hex");
      const a = randomBytes(2).readUInt16LE(),
        b = randomBytes(2).readUInt16LE();
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([
          ["checksum", "a", "b"],
          [checksum, a, b],
        ]),
        "Input",
      );
      const bytes: Buffer = XLSX.write(book, {
        type: "buffer",
        bookType: "xlsx",
      });
      const upload = await fetch(
        `http://127.0.0.1:${worker.endpoint.port}/attachments/upload`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${worker.endpoint.token}`,
            "x-file-name": "random-input.xlsx",
            "x-attachment-id": inputId,
            "x-conversation-id": conversationId,
          },
          body: new Uint8Array(bytes),
        },
      );
      assert.equal(upload.status, 200);
      const documents = await sandboxDocuments(
        directory,
        worker.endpoint,
        conversationId,
        checksum,
      );
      const input = `/inputs/${inputId}.xlsx`;
      const exec = (command: string) => ({ action: "exec", command });
      const security = `import os, socket\nassert os.getuid()==1000\nfor p in ${JSON.stringify(["/mnt/c/Users", "/mnt/d", "/run/aster", home.replaceAll("\\", "/"), otherWork.replaceAll("\\", "/")])}:\n assert not os.path.exists(p), p\nassert not any(k in os.environ for k in ['OPENAI_API_KEY','ANTHROPIC_API_KEY','ASTER_TOOL_TOKEN'])\ntry:\n open('${input}','wb')\n raise RuntimeError('input writable')\nexcept OSError as e:\n assert e.errno in (13,30)\nfor host in ['1.1.1.1','example.com','169.254.169.254']:\n try:\n  s=socket.create_connection((host,443),1);s.close();raise RuntimeError('network allowed')\n except OSError: pass\nprint('ISOLATION_OK')`;
      operations = [
        { action: "status" },
        exec(
          `cat > calculate.py <<'PY'\nimport openpyxl\nw=openpyxl.load_workbook('${input}')\ns=w.active\ns['D1']='sum'\ns['D2']=s['B2'].value+s['C2'].value\nw.save('/workspace/calculated.xlsx')\nprint(s['A2'].value)\nPY\nnode -e "require('fs').writeFileSync('node-proof.txt',process.versions.node)"`,
        ),
        exec(
          "python3 calculate.py && test \"$(cat node-proof.txt)\" = '22.23.1' && printf BASH_OK",
        ),
        exec(documents.command),
        { action: "read", path: "page.png" },
        { action: "read", path: "video.png" },
        exec("printf STDOUT_MARKER; printf STDERR_MARKER >&2; exit 7"),
        exec("python3 -c 'if :'"),
        exec(
          'python3 -c \'import sys; sys.stdout.write("x"*200000); sys.stderr.write("y"*200000)\'',
        ),
        exec(`python3 - <<'PY'\n${security}\nPY`),
        exec(
          "python3 - <<'PY'\nimport subprocess,sys\np=subprocess.Popen([sys.executable,'-c','import time; time.sleep(118)'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nopen('orphan.pid','w').write(str(p.pid))\nPY",
        ),
        exec(
          "python3 - <<'PY'\nimport os\npid=int(open('orphan.pid').read())\nassert not os.path.exists('/proc/'+str(pid)) or open('/proc/'+str(pid)+'/stat').read().split(') ',1)[1][0]=='Z'\nprint('DESCENDANTS_STOPPED')\nPY",
        ),
        { action: "list", path: "" },
        { action: "export", path: "calculated.xlsx", name: "calculated.xlsx" },
      ];
      step = 0;
      const run = await execute({
        type: "message.send",
        conversationId,
        text: "Read, compute and export the uploaded random XLSX in the isolated Linux script environment.",
        attachmentIds: [inputId, ...documents.ids],
      });
      assert.ok(run.id);
      const accepted = new Set<string>();
      const finish = async (runId: string, approve = true) => {
        const deadline = Date.now() + 180000;
        for (;;) {
          const view = await workerSnapshot(worker.endpoint, {
            conversationId,
          });
          for (const message of view.messages) {
            const call = message.computerTool;
            if (
              call?.status !== "pending" ||
              call.action.type !== "script" ||
              accepted.has(call.id) ||
              !approve
            )
              continue;
            const action = call.action;
            assert.ok(operations.some((op) => op.command === action.command));
            accepted.add(call.id);
            await execute({
              type: "tool.decide",
              id: call.id,
              conversationId,
              decision: "allow",
            });
          }
          const state = view.runs.find((item) => item.id === runId);
          if (
            state &&
            !["queued", "running", "cancelling"].includes(state.status)
          )
            return { view, state };
          assert.ok(Date.now() < deadline, "run did not settle");
          await delay(30);
        }
      };
      const firstStart = performance.now();
      const final = await finish(run.id);
      measurements.push({
        name: process.env.ASTER_TEST_MICROSANDBOX_CACHE
          ? "Pi Worker XLSX acceptance (copied image cache)"
          : "Pi Worker XLSX acceptance (cold)",
        durationMs: performance.now() - firstStart,
      });
      assert.equal(final.state.status, "completed", final.state.error ?? "");
      assert.equal(accepted.size, 9);
      assert.ok(
        final.view.messages.some(
          (message) =>
            message.tool?.exitCode === 0 &&
            message.tool.output.includes("PDF_WORD_VIDEO_OK"),
        ),
      );
      assert.ok(
        model.requests.some((request) =>
          /data:image\/png;base64,/.test(JSON.stringify(request.messages)),
        ),
      );
      assert.ok(
        final.view.messages.some((m) => m.tool?.output.includes("BASH_OK")),
      );
      assert.ok(
        final.view.messages.some(
          (m) =>
            m.tool?.exitCode === 7 && m.tool.output.includes("STDERR_MARKER"),
        ),
      );
      assert.ok(
        final.view.messages.some(
          (m) =>
            m.tool?.status === "failed" &&
            m.tool.output.includes("SyntaxError"),
        ),
      );
      assert.ok(final.view.messages.some((m) => m.tool?.truncated));
      assert.ok(
        final.view.messages.some((m) =>
          m.tool?.output.includes("ISOLATION_OK"),
        ),
      );
      const generated = final.view.messages
        .flatMap((m) => m.attachments)
        .find((a) => a.name === "calculated.xlsx");
      assert.ok(generated);
      const downloaded = attachmentContentSchema.parse(
        await callWorker(
          worker.endpoint,
          `/attachments/content?id=${generated.id}&conversationId=${conversationId}`,
        ),
      );
      const output = Buffer.from(downloaded.data, "base64");
      const table = XLSX.read(output).Sheets.Input;
      assert.ok(table);
      assert.equal(table.A2?.v, checksum);
      assert.equal(table.D2?.v, a + b);
      await writeFile(join(results, "microsandbox-generated.xlsx"), output);
      const original = attachmentContentSchema.parse(
        await callWorker(
          worker.endpoint,
          `/attachments/content?id=${inputId}&conversationId=${conversationId}`,
        ),
      );
      assert.deepEqual(Buffer.from(original.data, "base64"), bytes);
      await assert.rejects(
        callWorker(worker.endpoint, `/computer/state?botId=${botId}`),
        { code: "not_found" },
      );
      assert.deepEqual(
        await readdir(join(data, "workspaces", botId, "script-inputs")),
        [],
      );

      operations = [
        exec(
          "python3 - <<'PY'\nimport os\nlimited=False\ntry:\n with open('quota-probe.bin','wb') as f: f.truncate(600*1024*1024)\nexcept OSError as e:\n limited=e.errno in (28,122)\nfinally:\n if os.path.exists('quota-probe.bin'): os.unlink('quota-probe.bin')\nassert limited, 'workspace quota did not reject growth'\nprint('QUOTA_ENFORCED')\nPY",
        ),
      ];
      step = 0;
      const quota = await execute({
        type: "message.send",
        conversationId,
        text: "Verify workspace write quota",
      });
      assert.ok(quota.id);
      const quotaResult = await finish(quota.id);
      assert.equal(
        quotaResult.state.status,
        "completed",
        quotaResult.state.error ?? "",
      );
      assert.ok(
        quotaResult.view.messages.some(
          (m) =>
            m.runId === quota.id &&
            m.tool?.exitCode === 0 &&
            m.tool.output.includes("QUOTA_ENFORCED"),
        ),
      );

      await t.test(
        "approved HTTPS host is reachable while other destinations remain denied",
        async () => {
          operations = [
            {
              action: "exec",
              network: ["example.com"],
              command:
                // The virtual gateway can accept TCP/TLS locally to return a policy denial.
                // Assert the actual HTTP request is denied, including the SDK's structured 403.
                "set -e\npython3 - <<'PY'\nimport json,urllib.request,urllib.error\nwith urllib.request.urlopen('https://example.com',timeout=15) as r:\n assert r.status==200\nfor url in ['https://1.1.1.1/', 'http://example.com/', 'http://169.254.169.254/']:\n try:\n  with urllib.request.urlopen(url,timeout=3) as r:\n   raise RuntimeError('unapproved destination allowed: '+url)\n except urllib.error.HTTPError as e:\n  assert e.code==403 and json.loads(e.read(4096))['code']=='network_policy_denied', url\n except OSError: pass\nprint('APPROVED_HTTPS_ONLY')\nPY\nnode -e \"const req=require('https').get('https://example.com',r=>{r.resume();if(r.statusCode!==200)process.exitCode=1;else console.log('NODE_HTTPS_OK')});req.setTimeout(15000,()=>req.destroy(Error('timeout')));req.on('error',e=>{console.error(e.message);process.exitCode=1})\"",
            },
          ];
          step = 0;
          const network = await execute({
            type: "message.send",
            conversationId,
            text: "Verify one explicitly approved HTTPS host",
          });
          assert.ok(network.id);
          const networkResult = await finish(network.id);
          assert.equal(
            networkResult.state.status,
            "completed",
            networkResult.state.error ?? "",
          );
          assert.ok(
            networkResult.view.messages.some(
              (m) =>
                m.runId === network.id &&
                m.tool?.exitCode === 0 &&
                m.tool.output.includes("APPROVED_HTTPS_ONLY"),
            ),
            JSON.stringify(
              networkResult.view.messages
                .filter((m) => m.runId === network.id)
                .map((m) => m.tool ?? m.computerTool),
            ),
          );
        },
      );

      // Cancel a real setsid descendant after observing its file writes, not a timer guess.
      const longCommand =
        "python3 - <<'PY'\nimport subprocess,sys,time\np=subprocess.Popen([sys.executable,'-u','-c',\"import time; f=open('ticks.txt','a'); f.write('started\\\\n'); f.flush();\\nwhile True: f.write('tick\\\\n'); f.flush(); time.sleep(0.05)\"],start_new_session=True)\nopen('parent-ready.txt','w').write(str(p.pid))\ntime.sleep(120)\nPY";
      operations = [exec(longCommand)];
      step = 0;
      const cancelled = await execute({
        type: "message.send",
        conversationId,
        text: "Run cancellation fixture",
      });
      assert.ok(cancelled.id);
      let cancellationCall: string | undefined;
      const cancelDeadline = Date.now() + 30000;
      while (!cancellationCall) {
        const view = await workerSnapshot(worker.endpoint, { conversationId });
        cancellationCall = view.messages.find(
          (m) =>
            m.runId === cancelled.id && m.computerTool?.status === "pending",
        )?.computerTool?.id;
        assert.ok(Date.now() < cancelDeadline);
        if (!cancellationCall) await delay(20);
      }
      await execute({
        type: "tool.decide",
        id: cancellationCall,
        conversationId,
        decision: "allow",
      });
      while (
        !(
          await readFile(join(work, "ticks.txt"), "utf8").catch(() => "")
        ).includes("started")
      ) {
        assert.ok(Date.now() < cancelDeadline);
        await delay(20);
      }
      await execute({ type: "run.cancel", runId: cancelled.id });
      assert.equal(
        (await finish(cancelled.id, false)).state.status,
        "cancelled",
      );
      const ticks = await readFile(join(work, "ticks.txt"));
      await delay(250);
      assert.deepEqual(await readFile(join(work, "ticks.txt")), ticks);

      operations = [
        exec(
          "python3 -c \"open('reserved.bin','wb').truncate(8*1024*1024)\"\n" +
            longCommand.replaceAll("ticks.txt", "timeout-ticks.txt"),
        ),
        exec(
          "python3 - <<'PY'\nimport os\nlimited=False\ntry:\n with open('rebuild-quota.bin','wb') as f: f.truncate(510*1024*1024)\nexcept OSError as e:\n limited=e.errno in (28,122)\nfinally:\n if os.path.exists('rebuild-quota.bin'): os.unlink('rebuild-quota.bin')\n os.unlink('reserved.bin')\nassert limited, 'rebuild expanded the total workspace quota'\nprint('TIMEOUT_REBUILD_QUOTA_OK')\nPY",
        ),
      ];
      step = 0;
      const timeoutRun = await execute({
        type: "message.send",
        conversationId,
        text: "Verify the actual command timeout",
      });
      assert.ok(timeoutRun.id);
      const timeoutResult = await finish(timeoutRun.id);
      assert.equal(
        timeoutResult.state.status,
        "completed",
        timeoutResult.state.error ?? "",
      );
      assert.ok(
        timeoutResult.view.messages.some(
          (m) =>
            m.runId === timeoutRun.id &&
            m.tool?.status === "failed" &&
            m.tool.exitCode === null &&
            m.tool.output.includes("60000ms"),
        ),
      );
      const timedTool = timeoutResult.view.messages.find(
        (m) => m.runId === timeoutRun.id && m.tool,
      )?.tool;
      assert.ok(
        timedTool?.durationMs !== null && timedTool?.durationMs !== undefined,
      );
      assert.ok(timedTool.durationMs >= 60000 && timedTool.durationMs < 75000);
      assert.ok(
        timeoutResult.view.messages.some(
          (m) =>
            m.runId === timeoutRun.id &&
            m.tool?.exitCode === 0 &&
            m.tool.output.includes("TIMEOUT_REBUILD_QUOTA_OK"),
        ),
      );
      measurements.push({
        name: "60-second timeout and VM destruction",
        durationMs: timedTool.durationMs,
      });
      const timeoutTicks = await readFile(join(work, "timeout-ticks.txt"));
      await delay(250);
      assert.deepEqual(
        await readFile(join(work, "timeout-ticks.txt")),
        timeoutTicks,
      );

      // Stop and reopen the same isolated data directory; working files survive VM destruction.
      await worker.stop();
      worker = await startWorker(directory, { port: 0 });
      operations = [
        exec(
          "python3 - <<'PY'\nimport openpyxl\nassert openpyxl.load_workbook('calculated.xlsx').active['D2'].value is not None\nprint('RESTORED_WORKSPACE')\nPY",
        ),
      ];
      step = 0;
      const resumed = await execute({
        type: "message.send",
        conversationId,
        text: "Verify persisted script work",
      });
      assert.ok(resumed.id);
      const resumedResult = await finish(resumed.id);
      assert.equal(
        resumedResult.state.status,
        "completed",
        resumedResult.state.error ?? "",
      );
      assert.ok(
        resumedResult.view.messages.some(
          (m) =>
            m.runId === resumed.id &&
            m.tool?.output.includes("RESTORED_WORKSPACE"),
        ),
      );
      const runtime = join(data, "scripts", "runtime", "sandboxes");
      operations = [
        exec(longCommand.replaceAll("ticks.txt", "shutdown-ticks.txt")),
      ];
      step = 0;
      const stopping = await execute({
        type: "message.send",
        conversationId,
        text: "Verify shutdown while script and descendant are active",
      });
      assert.ok(stopping.id);
      let stoppingCall: string | undefined;
      const stoppingDeadline = Date.now() + 30000;
      while (!stoppingCall) {
        stoppingCall = (
          await workerSnapshot(worker.endpoint, { conversationId })
        ).messages.find(
          (m) =>
            m.runId === stopping.id && m.computerTool?.status === "pending",
        )?.computerTool?.id;
        assert.ok(Date.now() < stoppingDeadline);
        if (!stoppingCall) await delay(20);
      }
      await execute({
        type: "tool.decide",
        id: stoppingCall,
        conversationId,
        decision: "allow",
      });
      while (
        !(
          await readFile(join(work, "shutdown-ticks.txt"), "utf8").catch(
            () => "",
          )
        ).includes("started")
      ) {
        assert.ok(Date.now() < stoppingDeadline);
        await delay(20);
      }
      await worker.stop();
      const shutdownTicks = await readFile(join(work, "shutdown-ticks.txt"));
      await delay(250);
      assert.deepEqual(
        await readFile(join(work, "shutdown-ticks.txt")),
        shutdownTicks,
      );
      await assert.rejects(callWorker(worker.endpoint, "/health"));
      assert.deepEqual(await readdir(runtime).catch(() => []), []);
      await access(join(work, "calculated.xlsx"));
      await writeFile(
        join(results, "microsandbox-acceptance.json"),
        JSON.stringify(
          {
            platform: process.platform,
            arch: process.arch,
            runtimeCacheSeeded: Boolean(
              process.env.ASTER_TEST_MICROSANDBOX_CACHE,
            ),
            measurements,
            approvals: accepted.size,
            checksum,
            expectedSum: a + b,
            outputBytes: output.length,
          },
          null,
          2,
        ),
      );
    } finally {
      try {
        await worker.stop();
      } finally {
        await model.close();
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

await test(
  "Microsandbox cancellation retires only its Bot while a second real VM finishes",
  {
    skip:
      process.env.ASTER_TEST_MICROSANDBOX !== "1"
        ? "requires a real Microsandbox host"
        : false,
    timeout: 180000,
  },
  async () => {
    const parent = resolve(".runtime/test-results");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "microsandbox-concurrency-"));
    await seedRuntimeCache(root);
    const store = new Store(":memory:");
    const execute = (command: Command) =>
      store.execute({ id: randomUUID(), command });
    const create = (name: string) => {
      const bot = execute({ type: "bot.create", name, description: "" });
      assert.ok(bot.id && bot.conversationId);
      execute({
        type: "message.send",
        conversationId: bot.conversationId,
        text: name,
      });
      const job = store.runs.claim();
      assert.ok(job);
      return job;
    };
    const a = create("Cancelled VM"),
      b = create("Independent VM");
    const sandbox = new SandboxService(store, root);
    const tools = new ToolService(store, 12345, undefined, undefined, sandbox);
    const controllerA = new AbortController(),
      controllerB = new AbortController();
    const scopeA = tools.open(a, controllerA.signal),
      scopeB = tools.open(b, controllerB.signal);
    const approve = (job: typeof a) => {
      const call = store
        .snapshotSince({ conversationId: job.conversationId })
        ?.messages.find(
          (m) => m.computerTool?.status === "pending",
        )?.computerTool;
      assert.ok(call);
      execute({
        type: "tool.decide",
        id: call.id,
        conversationId: job.conversationId,
        decision: "allow",
      });
    };
    const waitFile = async (job: typeof a, name: string) => {
      const path = join(root, "workspaces", job.botId, "script-work", name);
      const deadline = Date.now() + 120000;
      while (true) {
        try {
          await access(path);
          return path;
        } catch {
          assert.ok(Date.now() < deadline);
          await delay(20);
        }
      }
    };
    try {
      const pendingA = tools.scripts(
        scopeA.connection.token,
        {
          callId: "a",
          operation: {
            action: "exec",
            command:
              "python3 -c \"import time; open('ready.txt','w').write('ready'); time.sleep(120)\"",
          },
        },
        controllerA.signal,
      );
      const cancelled = assert.rejects(
        pendingA,
        (e: Error) => e.name === "AbortError",
      );
      approve(a);
      await waitFile(a, "ready.txt");
      const pendingB = tools.scripts(
        scopeB.connection.token,
        {
          callId: "b",
          operation: {
            action: "exec",
            command:
              "python3 -u -c \"import time; f=open('alive.txt','w'); f.write('ready'); f.flush(); time.sleep(3); f.write('done'); f.flush()\"",
          },
        },
        controllerB.signal,
      );
      approve(b);
      const path = await waitFile(b, "alive.txt");
      controllerA.abort();
      await cancelled;
      await scopeA.close();
      assert.equal(controllerB.signal.aborted, false);
      const result = scriptResultSchema.parse(await pendingB);
      assert.equal(result.action, "exec");
      if (result.action === "exec") assert.equal(result.result.exitCode, 0);
      assert.equal(await readFile(path, "utf8"), "readydone");
    } finally {
      await Promise.all([scopeA.close(), scopeB.close()]);
      await sandbox.stop();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

await test(
  "Microsandbox initialization cancellation awaits cleanup despite native creation errors",
  {
    skip: process.env.ASTER_TEST_MICROSANDBOX !== "1",
    timeout: 750000,
  },
  async () => {
    const root = await mkdtemp(
      resolve(".runtime/test-results/microsandbox-initialization-"),
    );
    const workspace = join(root, "workspace"),
      inputs = join(root, "inputs"),
      home = join(root, "scripts", "runtime");
    await mkdir(workspace);
    await mkdir(inputs);
    const controller = new AbortController();
    const resources = new SandboxResources(join(root, "scripts"));
    let initializing = false;
    const process = new SandboxProcess(controller.signal, (detail) => {
      if (detail.includes("微型虚拟机")) {
        initializing = true;
        controller.abort();
      }
    });
    try {
      await seedRuntimeCache(root);
      await resources.wait(AbortSignal.timeout(600000), () => {});
      await assert.rejects(
        process.open({
          workspace,
          inputs,
          home,
          assets: join(root, "scripts", "assets"),
          name: `aster-script-${randomUUID()}`,
          quotaMiB: 512,
          network: [],
        }),
        { name: "AbortError" },
      );
      assert.equal(initializing, true);
      await process.close();
      assert.deepEqual(
        await readdir(join(home, "sandboxes")).catch(() => []),
        [],
      );
    } finally {
      await process.close();
      await resources.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
