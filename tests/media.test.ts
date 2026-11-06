import { WorkspaceCommands } from "../src/worker/commands.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectAttachment } from "../src/attachments/content.js";
import { materializeAttachments } from "../src/attachments/materialize.js";
import type { Agent, AgentInput, AgentResult } from "../src/chat/agent.js";
import { Runtime } from "../src/chat/runtime.js";
import { maxAttachmentBytes } from "../src/shared/files/attachments.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";

const command = (value: Command) =>
  envelopeSchema.parse({ id: randomUUID(), command: value });
const wav = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVEfmt "),
  Buffer.from("tone"),
]);
const samples = {
  "clip.wav": wav,
  "clip.mp3": Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00]),
  "clip.ogg": Buffer.from("OggS"),
  "clip.m4a": Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]),
  "clip.mp4": Buffer.concat([Buffer.alloc(4), Buffer.from("ftypmp42")]),
  "clip.webm": Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]),
};

await test("audio and video are stored only when the container matches, then handed to the agent as files", async () => {
  assert.equal(inspectAttachment("clip.wav", wav).kind, "audio");
  assert.equal(inspectAttachment("clip.wav", wav).mime, "audio/wav");
  assert.equal(
    inspectAttachment("clip.mp3", samples["clip.mp3"]).mime,
    "audio/mpeg",
  );
  assert.equal(
    inspectAttachment("clip.ogg", samples["clip.ogg"]).mime,
    "audio/ogg",
  );
  assert.equal(
    inspectAttachment("clip.m4a", samples["clip.m4a"]).mime,
    "audio/mp4",
  );
  assert.equal(
    inspectAttachment("clip.mp4", samples["clip.mp4"]).kind,
    "video",
  );
  assert.equal(
    inspectAttachment("clip.webm", samples["clip.webm"]).mime,
    "video/webm",
  );
  assert.throws(
    () => inspectAttachment("clip.mp4", Buffer.from("not media")),
    /无法确认/,
  );
  assert.throws(
    () => inspectAttachment("clip.zip", Buffer.from("PK")),
    /尚未接入/,
  );
  const directory = await mkdtemp(join(tmpdir(), "aster-media-"));
  const store = new Store(join(directory, "db.sqlite"));
  try {
    const created = store.execute(
      command({ type: "bot.create", name: "Media", description: "desc" }),
    );
    const conversationId = created.conversationId;
    assert.ok(conversationId);
    assert.throws(
      () =>
        store.files.registerAttachment(
          { id: randomUUID(), conversationId, name: "clip.mp4" },
          Buffer.from("not media"),
        ),
      /无法确认/,
    );
    assert.equal(
      store.views.snapshot({ conversationId }).conversations[0]
        ?.draftAttachments.length,
      0,
    );
    const saved = store.files.registerAttachment(
      { id: randomUUID(), conversationId, name: "clip.wav" },
      wav,
    );
    assert.equal(saved.kind, "audio");
    store.execute(
      command({
        type: "attachment.remove",
        conversationId,
        id: saved.id,
      }),
    );
    assert.throws(
      () => store.files.attachmentContent(conversationId, saved.id),
      /移除/,
    );
    const kept = store.files.registerAttachment(
      { id: randomUUID(), conversationId, name: "clip.wav" },
      wav,
    );
    const run = store.execute(
      command({
        type: "message.send",
        conversationId,
        text: "listen",
        attachmentIds: [kept.id],
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    assert.equal(job.id, run.id);
    const root = join(directory, "workspaces");
    const workspace = join(root, job.botId);
    await mkdir(workspace, { recursive: true });
    const files = await materializeAttachments(
      store,
      root,
      workspace,
      job,
      new AbortController().signal,
    );
    assert.equal(files[0]?.kind, "audio");
    assert.match(files[0]?.path ?? "", /\.wav$/);
    assert.deepEqual(await readFile(files[0]?.path ?? ""), wav);
    for (let index = 0; index < 8; index++) {
      const produced = store.files.saveAgentFile(
        job,
        `out-${index}.bin`,
        Buffer.from(`byte-${index}`),
      );
      assert.equal(produced?.kind, "file");
      assert.equal(produced?.mime, "application/octet-stream");
    }
    const extra = store.files.registerAttachment(
      { id: randomUUID(), conversationId, name: "again.txt" },
      Buffer.from("still allowed"),
    );
    assert.doesNotThrow(() =>
      store.execute(
        command({
          type: "message.send",
          conversationId,
          text: "more",
          attachmentIds: [extra.id],
        }),
      ),
    );
    assert.throws(
      () =>
        store.files.saveAgentFile(
          job,
          "huge.bin",
          Buffer.alloc(maxAttachmentBytes + 1),
        ),
      /25 MiB/,
    );
    const closed = store;
    closed.close();
    const reopened = new Store(join(directory, "db.sqlite"));
    try {
      const message = reopened.views
        .snapshot({ conversationId })
        .messages.find((item) => item.text === "已保存成果文件：out-0.bin");
      const attachment = message?.attachments[0];
      assert.ok(attachment);
      assert.equal(attachment.kind, "file");
      assert.ok(
        Buffer.from(
          reopened.files.attachmentContent(conversationId, attachment.id).bytes,
        ).equals(Buffer.from("byte-0")),
      );
    } finally {
      reopened.close();
    }
  } finally {
    try {
      store.close();
    } catch {
      // The success path already closed this connection before reopening.
    }
    await rm(directory, { recursive: true, force: true });
  }
});

await test("a granted directory can be read only inside that conversation and root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-grant-"));
  const store = new Store(join(directory, "db.sqlite"));
  const granted = join(directory, "granted");
  const outside = join(directory, "outside");
  try {
    await mkdir(granted);
    await mkdir(outside);
    await writeFile(join(granted, "note.txt"), "inside");
    await writeFile(join(outside, "secret.txt"), "hidden");
    await mkdir(join(granted, "nested"));
    await symlink(
      outside,
      join(granted, "leak"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const created = store.execute(
      command({ type: "bot.create", name: "Dirs", description: "" }),
    );
    const conversationId = created.conversationId;
    assert.ok(conversationId);
    assert.ok(created.id);
    const other = store.execute(
      command({ type: "conversation.create", botId: created.id }),
    ).conversationId;
    assert.ok(other);
    assert.throws(
      () =>
        store.execute(
          command({
            type: "directory.attach",
            conversationId,
            root: join(granted, "note.txt"),
          }),
        ),
      /实际目录/,
    );
    assert.throws(
      () =>
        store.execute(
          command({
            type: "directory.attach",
            conversationId,
            root: join(granted, "leak"),
          }),
        ),
      /符号链接/,
    );
    const attached = store.execute(
      command({ type: "directory.attach", conversationId, root: granted }),
    );
    assert.equal(
      store.execute(
        command({ type: "directory.attach", conversationId, root: granted }),
      ).id,
      attached.id,
    );
    const grantedRoot = store.files.directoryGrants(conversationId)[0]?.root;
    assert.ok(grantedRoot);
    assert.equal(
      store.views
        .snapshot({})
        .conversations.find((item) => item.id === conversationId)
        ?.directoryGrants[0]?.root,
      grantedRoot,
    );
    const grantId = attached.id;
    assert.ok(grantId);
    assert.equal(
      Buffer.from(
        store.files.readGrantedFile(conversationId, grantId, "note.txt"),
      ).toString(),
      "inside",
    );
    assert.throws(
      () =>
        store.files.readGrantedFile(
          conversationId,
          grantId,
          "../outside/secret.txt",
        ),
      /超出/,
    );
    assert.throws(
      () =>
        store.files.readGrantedFile(conversationId, grantId, "leak/secret.txt"),
      /超出/,
    );
    assert.throws(
      () => store.files.readGrantedFile(other, grantId, "note.txt"),
      /不属于/,
    );
    assert.throws(
      () => store.files.readGrantedFile(conversationId, grantId, "nested"),
      /只允许读取文件/,
    );
    assert.throws(
      () => store.files.readGrantedFile(conversationId, grantId, "missing.txt"),
      /没有这个文件/,
    );
    await writeFile(
      join(granted, "big.bin"),
      Buffer.alloc(maxAttachmentBytes + 1),
    );
    assert.throws(
      () => store.files.readGrantedFile(conversationId, grantId, "big.bin"),
      /25 MiB/,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

class RecordingAgent implements Agent {
  input: Promise<AgentInput>;
  private open: (input: AgentInput) => void = () => {};
  private finish: (result: AgentResult) => void = () => {};
  private readonly result: Promise<AgentResult>;
  constructor() {
    this.input = new Promise((resolve) => {
      this.open = resolve;
    });
    this.result = new Promise((resolve) => {
      this.finish = resolve;
    });
  }
  check() {
    return Promise.resolve({ accountType: "test", detail: "fixture" });
  }
  complete(result: AgentResult) {
    this.finish(result);
  }
  run(input: AgentInput) {
    this.open(input);
    return this.result;
  }
}

await test("runtime passes media files and saves an agent file that survives the run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-agent-file-"));
  const store = new Store(join(directory, "db.sqlite"));
  const agent = new RecordingAgent();
  const runtime = new Runtime(store, agent, join(directory, "workspaces"));
  const commands = new WorkspaceCommands(store, runtime);
  const granted = join(directory, "granted");
  try {
    await mkdir(granted);
    await writeFile(join(granted, "note.txt"), "readable");
    const send = (value: Command) => commands.execute(command(value));
    const conversationId = send({
      type: "bot.create",
      name: "Output",
      description: "bot",
    }).conversationId;
    assert.ok(conversationId);
    const file = store.files.registerAttachment(
      { id: randomUUID(), conversationId, name: "clip.wav" },
      wav,
    );
    const grant = store.execute(
      command({ type: "directory.attach", conversationId, root: granted }),
    );
    assert.ok(grant.id);
    const grantId = grant.id;
    send({
      type: "message.send",
      conversationId,
      text: "use the clip",
      attachmentIds: [file.id],
    });
    const input = await agent.input;
    assert.match(input.attachments?.[0]?.path ?? "", /\.wav$/);
    assert.deepEqual(await readFile(input.attachments?.[0]?.path ?? ""), wav);
    assert.match(input.instructions, new RegExp(grantId));
    assert.equal(
      Buffer.from(
        store.files.readGrantedFile(conversationId, grantId, "note.txt"),
      ).toString(),
      "readable",
    );
    assert.throws(
      () =>
        store.files.readGrantedFile(
          conversationId,
          grantId,
          "../granted/../note.txt",
        ),
      /超出|没有这个文件|unauthorized/,
    );
    input.onEvent({
      type: "file",
      name: "result.bin",
      data: Buffer.from("persisted"),
    });
    agent.complete({ status: "completed", error: null });
    await runtime.stop();
    const visible = store.views
      .snapshot({ conversationId })
      .messages.find((item) => item.text === "已保存成果文件：result.bin");
    assert.equal(visible?.attachments[0]?.kind, "file");
    store.close();
    const reopened = new Store(join(directory, "db.sqlite"));
    try {
      const again = reopened.views
        .snapshot({ conversationId })
        .messages.find((item) => item.text === "已保存成果文件：result.bin");
      const id = again?.attachments[0]?.id;
      assert.ok(id);
      assert.ok(
        Buffer.from(
          reopened.files.attachmentContent(conversationId, id).bytes,
        ).equals(Buffer.from("persisted")),
      );
    } finally {
      reopened.close();
    }
  } finally {
    agent.complete({ status: "cancelled", error: null });
    try {
      await runtime.stop();
    } catch {
      // The run already stopped before the database was reopened.
    }
    try {
      store.close();
    } catch {
      // The success path already closed this connection before reopening.
    }
    await rm(directory, { recursive: true, force: true });
  }
});

class InvalidFileAgent implements Agent {
  readonly started: Promise<void>;
  private open: () => void = () => {};
  constructor() {
    this.started = new Promise((resolve) => {
      this.open = resolve;
    });
  }
  check() {
    return Promise.resolve({ accountType: "test", detail: "fixture" });
  }
  run(input: AgentInput): Promise<AgentResult> {
    this.open();
    input.onEvent({
      type: "file",
      name: "nested/secret.bin",
      data: Buffer.from("nope"),
    });
    return Promise.resolve({ status: "completed", error: null });
  }
}

await test("an invalid agent file name fails the run instead of looking saved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-bad-file-"));
  const store = new Store(join(directory, "db.sqlite"));
  const agent = new InvalidFileAgent();
  const runtime = new Runtime(store, agent, join(directory, "workspaces"));
  const commands = new WorkspaceCommands(store, runtime);
  try {
    const send = (value: Command) => commands.execute(command(value));
    const conversationId = send({
      type: "bot.create",
      name: "Bad",
      description: "",
    }).conversationId;
    assert.ok(conversationId);
    const runId = send({
      type: "message.send",
      conversationId,
      text: "produce",
    }).id;
    assert.ok(runId);
    await agent.started;
    await runtime.stop();
    const finished = store.runs.getRun(runId);
    assert.equal(finished?.status, "failed");
    assert.match(finished?.error ?? "", /成果文件名/);
    assert.equal(
      store.views
        .snapshot({ conversationId })
        .messages.some((item) => item.text.includes("已保存成果文件")),
      false,
    );
  } finally {
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
