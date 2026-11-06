import { randomUUID } from "node:crypto";
import type { Job, Store } from "../storage/store.js";
import type { SandboxService } from "../sandbox/service.js";
import { AppError } from "../shared/core.js";
import {
  readRequestSchema,
  type ReadInput,
  type ReadResult,
} from "../shared/files/reads.js";
import { readGrantedBytes, readGrantedPath } from "../files/read.js";
import { readContent, readText } from "./read-content.js";

type Sandbox = ReturnType<SandboxService["open"]>;

/** Virtual paths preserve conversation ownership without exposing host paths or the database. */
export class ReadSession {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<ReadResult>>();
  private readonly grants = new Map<AbortController, string>();
  private attempts = 0;
  constructor(
    private readonly store: Pick<
      Store,
      "files" | "runs" | "subscribe" | "toolOperations"
    >,
    private readonly job: Job,
    private readonly sandbox: Sandbox | undefined,
  ) {}
  request(value: unknown, transport: AbortSignal) {
    const input = readRequestSchema.parse(value);
    if (++this.attempts > 128 || this.pending.size >= 2)
      throw new AppError("capacity", "本轮最多读取 128 次，同时最多两个读取。");
    const access = new AbortController();
    const signal = AbortSignal.any([
      transport,
      access.signal,
      this.controller.signal,
    ]);
    const grantId =
      input.path.split("/")[1] === "grants"
        ? input.path.split("/")[2]
        : undefined;
    if (grantId) this.grants.set(access, grantId);
    const task = (async () => {
      signal.throwIfAborted();
      this.store.files.requireFileRun(this.job);
      const result = await this.read(input, signal);
      signal.throwIfAborted();
      this.store.files.requireFileRun(this.job);
      if (grantId) this.store.files.fileGrantRoot(this.job, grantId);
      return result;
    })();
    this.pending.add(task);
    void task
      .finally(() => {
        this.pending.delete(task);
        this.grants.delete(access);
      })
      .catch(() => {});
    return task;
  }
  private directory(
    input: ReadInput,
    entries: Extract<ReadResult, { type: "directory" }>["entries"],
  ): ReadResult {
    return {
      type: "directory",
      path: input.path,
      entries: entries.slice(input.offset, input.offset + 100),
      nextOffset:
        input.offset + 100 < entries.length ? input.offset + 100 : null,
    };
  }
  private async read(
    input: ReadInput,
    signal: AbortSignal,
  ): Promise<ReadResult> {
    const parts = input.path.split("/").filter(Boolean);
    const [root, id, version, file] = parts;
    if (!root)
      return this.directory(
        input,
        ["inputs", "workspace", "skills", "history", "grants"].map((name) => ({
          path: `/${name}`,
          name,
          kind: "directory",
        })),
      );
    if (root === "skills") {
      if (!id)
        return this.directory(
          input,
          this.store.toolOperations
            .skillDiscoveryCatalog(this.job)
            .map((skill) => ({
              path: `/skills/${skill.id}/${skill.revision}/SKILL.md`,
              name: skill.name,
              kind: "file",
              description: skill.description,
            })),
        );
      if (parts.length !== 4 || file !== "SKILL.md")
        throw new AppError("invalid_input", "请使用技能目录中的完整版本路径。");
      const result = this.store.toolOperations.skillToolRequest(this.job, {
        callId: `read:${randomUUID()}`,
        operation: { action: "read", id, revision: Number(version) },
      });
      if (result.action !== "read")
        throw new AppError("internal", "技能读取响应不匹配。");
      return readText(result.skill.body, input);
    }
    if (root === "history") {
      if (!id) {
        const result = this.store.runs.historyRequest(this.job, {
          operation: {
            action: "list",
            limit: 20,
            ...(input.offset ? { before: input.offset } : {}),
          },
        });
        if (result.action === "read")
          throw new AppError("internal", "历史目录响应不匹配。");
        return {
          type: "directory",
          path: input.path,
          entries: result.messages.map((message) => ({
            path: `/history/${message.id}.md`,
            name: `${message.role}: ${message.preview}`,
            kind: "file",
            description: `runStatus=${message.runStatus}; sequence=${message.sequence}; createdAt=${message.createdAt}`,
          })),
          nextOffset: result.nextBefore,
        };
      }
      if (parts.length !== 2)
        throw new AppError("invalid_input", "请使用历史目录中的文件路径。");
      const result = this.store.runs.historyRequest(this.job, {
        operation: {
          action: "read",
          id: id.replace(/\.md$/, ""),
          offset: input.offset,
        },
      });
      if (result.action !== "read")
        throw new AppError("internal", "历史读取响应不匹配。");
      let end = Math.min(result.text.length, input.limit);
      if (
        end < result.text.length &&
        /[\uD800-\uDBFF]/.test(result.text[end - 1] ?? "")
      )
        end += end === 1 ? 1 : -1;
      const text = result.text.slice(0, end);
      const next = input.offset + text.length;
      return {
        type: "text",
        path: input.path,
        text,
        metadata: {
          message: result.message,
          attachments: result.attachments,
          totalCharacters: result.totalCharacters,
        },
        nextOffset: next < result.totalCharacters ? next : null,
      };
    }
    if (root === "grants") {
      if (!id)
        return this.directory(
          input,
          this.store.files
            .directoryGrants(this.job.conversationId)
            .map((grant) => ({
              path: `/grants/${grant.id}`,
              name: grant.root,
              kind: "directory",
            })),
        );
      const host = this.store.files.fileGrantRoot(this.job, id);
      const path = parts.slice(2).join("/");
      try {
        const result = await readGrantedPath(
          host,
          { action: "list", grantId: id, path, offset: input.offset },
          signal,
        );
        if (result.action !== "list")
          throw new AppError("internal", "目录响应不匹配。");
        return {
          type: "directory",
          path: input.path,
          entries: result.entries.map((entry) => ({
            ...entry,
            path: `${input.path.replace(/\/$/, "")}/${entry.name}`,
          })),
          nextOffset: result.nextOffset,
        };
      } catch (error) {
        if (!(error instanceof AppError && error.code === "invalid_input"))
          throw error;
      }
      const bytes = await readGrantedBytes(host, path, signal);
      this.store.files.fileGrantRoot(this.job, id);
      if (!this.sandbox)
        throw new AppError("unavailable", "文件沙箱服务未就绪。");
      const staged = await this.sandbox.stage(path, bytes, signal);
      return readContent(bytes, input, staged);
    }
    if (root !== "workspace" && root !== "inputs")
      throw new AppError("unauthorized", "路径不属于当前可读范围。");
    if (!this.sandbox)
      throw new AppError("unavailable", "文件沙箱服务未就绪。");
    const result = await this.sandbox.read(input.path, signal, input.offset);
    if (result.type === "file")
      return readContent(result.bytes, input, input.path);
    return {
      type: "directory",
      path: input.path,
      entries: result.entries.map((entry) => ({
        ...entry,
        path: `${input.path.replace(/\/$/, "")}/${entry.name}`,
      })),
      nextOffset: result.nextOffset,
    };
  }
  refreshGrants() {
    for (const [controller, id] of this.grants) {
      try {
        this.store.files.fileGrantRoot(this.job, id);
      } catch (error) {
        controller.abort(error);
      }
    }
  }
  cancel() {
    this.controller.abort();
  }
  async close() {
    this.cancel();
    await Promise.allSettled([...this.pending]);
  }
}
