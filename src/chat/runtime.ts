import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { materializeAttachments } from "../attachments/materialize.js";
import { AppError } from "../shared/core.js";
import type { Job, Store } from "../storage/store.js";
import type { ToolService } from "../tools/service.js";
import type { Agent, AgentEvent, AgentResult } from "./agent.js";
import { groupOutput } from "./group-output.js";
import { StreamBuffer } from "./stream-buffer.js";
import { ContextManager } from "./context-manager.js";
import { skillDiscoveryContext } from "./skill-discovery.js";
import { groupTurnLimit, type GroupJudge } from "../shared/chat/group-host.js";

/** Owns two bounded Bot lanes. Shared computer resources retain their own exclusive owner. */
export class Runtime {
  private stopping = false;
  private updatePaused = false;
  private readonly active = new Map<
    string,
    { job: Job; controller: AbortController; finished: Promise<void> }
  >();
  private loop: Promise<void> | undefined;
  private requested = false;
  constructor(
    private readonly store: Pick<
      Store,
      | "runs"
      | "files"
      | "memoryOperations"
      | "routineOperations"
      | "toolOperations"
      | "conversationContext"
    >,
    private readonly agent: Agent,
    private readonly workspaces: string,
    private readonly onMemoryWork: () => void = () => {},
    private readonly tools?: ToolService,
    private readonly deadlineMs = 10 * 60 * 1000,
    private readonly groupJudge?: (hostBotId: string) => Promise<GroupJudge>,
  ) {}
  cancel(runId: string) {
    this.active.get(runId)?.controller.abort();
  }
  pauseForUpdate(paused: boolean) {
    this.updatePaused = paused;
    if (!paused) this.wake();
  }
  get updateBusy() {
    return this.active.size;
  }
  wake() {
    for (const active of this.active.values())
      if (this.store.runs.getRun(active.job.id)?.status === "cancelling")
        active.controller.abort();
    this.requested = true;
    if (this.loop || this.stopping) return;
    this.requested = false;
    this.loop = this.pump()
      .catch((error) => {
        // Unexpected database failures halt intake rather than claiming that a run succeeded.
        this.stopping = true;
        for (const active of this.active.values()) active.controller.abort();
        console.error(
          "worker execution halted",
          error instanceof Error ? error.name : "Error",
        );
      })
      .finally(() => {
        this.loop = undefined;
        if (this.requested && !this.stopping) this.wake();
      });
  }
  private async pump() {
    while (!this.stopping && !this.updatePaused && this.active.size < 2) {
      const job = this.store.runs.claim();
      if (!job) return;
      const controller = new AbortController();
      const finished = Promise.resolve()
        .then(() => this.executeJob(job, controller))
        .catch((error: unknown) => {
          this.stopping = true;
          for (const active of this.active.values()) active.controller.abort();
          console.error(
            "worker execution halted",
            error instanceof Error ? error.name : "Error",
          );
        })
        .finally(() => {
          this.active.delete(job.id);
          if (!this.stopping) this.wake();
        });
      this.active.set(job.id, { job, controller, finished });
    }
  }
  private async executeJob(job: Job, controller: AbortController) {
    const timeout = new AppError(
      "unavailable",
      `运行超过 ${Math.round(this.deadlineMs / 60_000)} 分钟，已请求取消，正在等待资源收尾。`,
    );
    const deadline = setTimeout(() => {
      if (controller.signal.aborted) return;
      try {
        this.store.runs.cancel(job.id, timeout.message);
        controller.abort(timeout);
      } catch (error) {
        controller.abort(error);
      }
    }, this.deadlineMs);
    try {
      this.throwAbortReason(controller.signal);
      if (this.store.runs.getRun(job.id)?.groupTurns.length) {
        await this.discuss(job, controller.signal, timeout);
        this.throwAbortReason(controller.signal);
      } else {
        const agent = this.agent.capture?.(job.botId) ?? this.agent;
        // Cancellation starts cleanup; ownership ends only when the Agent and tools settle.
        const result = await this.perform(job, controller.signal, agent);
        this.throwAbortReason(controller.signal);
        if (!result.settled)
          this.store.runs.finish(job.id, result.status, result.error);
      }
    } catch (error) {
      this.finishFailedRun(job, controller, error, timeout);
    } finally {
      clearTimeout(deadline);
      this.onMemoryWork();
    }
  }
  private finishFailedRun(
    job: Job,
    controller: AbortController,
    error: unknown,
    timeout: AppError,
  ) {
    const reason = controller.signal.reason;
    const timedOut =
      reason === timeout ||
      error === timeout ||
      reason?.name === "TimeoutError";
    const unknown =
      !timedOut &&
      ((error instanceof AppError && error.code === "unknown") ||
        (reason instanceof AppError && reason.code === "unknown"));
    const detail =
      timedOut && error === timeout
        ? "运行已到达时限，Agent 取消与资源收尾已完成。"
        : error instanceof Error
          ? error.message
          : "运行失败。";
    this.store.runs.finish(
      job.id,
      !unknown &&
        !timedOut &&
        controller.signal.aborted &&
        error instanceof Error &&
        error.name === "AbortError"
        ? "cancelled"
        : unknown
          ? "unknown"
          : "failed",
      detail,
    );
  }
  private throwAbortReason(signal: AbortSignal) {
    if (signal.reason instanceof Error && signal.reason.name !== "AbortError")
      throw signal.reason;
  }
  private async discuss(parent: Job, signal: AbortSignal, timeout: AppError) {
    let failed = false;
    const hosted = this.store.runs.host.info(parent.id);
    const judge = hosted
      ? await this.groupJudge?.(hosted.hostBotId)
      : undefined;
    if (hosted && !judge)
      throw new AppError("unavailable", "主持人调度服务未装配。");
    while (!signal.aborted) {
      const job = this.store.runs.nextGroupTurn(
        parent,
        this.agent.retainCancelledContext ?? true,
      );
      if (!job) break;
      try {
        const agent = this.agent.capture?.(job.botId) ?? this.agent;
        const result = await this.perform(job, signal, agent);
        if (signal.reason === timeout) return;
        this.throwAbortReason(signal);
        this.store.runs.finishGroupTurn(
          job,
          result.status === "completed" && !result.contributed
            ? "skipped"
            : result.status,
          result.error,
        );
        if (result.status === "cancelled") break;
        failed ||= result.status === "failed";
      } catch (error) {
        const reason = signal.reason;
        const lostLease =
          reason instanceof AppError && reason.code === "unknown";
        const timedOut =
          reason === timeout ||
          error === timeout ||
          reason?.name === "TimeoutError";
        const status = lostLease
          ? "unknown"
          : !timedOut &&
              signal.aborted &&
              error instanceof Error &&
              error.name === "AbortError"
            ? "cancelled"
            : error instanceof AppError && error.code === "unknown"
              ? "unknown"
              : "failed";
        const detail =
          error instanceof Error ? error.message : "成员运行失败。";
        if (timedOut) return;
        this.store.runs.finishGroupTurn(job, status, detail);
        if (status === "unknown") {
          this.store.runs.finish(parent.id, "unknown", detail);
          return;
        }
        if (status === "cancelled") break;
        failed = true;
      }
      if (hosted && judge && !signal.aborted) {
        const info = this.store.runs.host.info(parent.id);
        if (info?.ending) {
          failed ||= info.ending === "limit";
          if (
            this.store.runs.getRun(parent.id)?.groupTurns.at(-1)?.status ===
            "skipped"
          )
            throw new AppError(
              "unavailable",
              "主持人未交付收尾回复，请检查成员执行记录。",
            );
          break;
        }
        const state = this.store.runs.host.state(parent);
        const decision =
          state.turns.length >= groupTurnLimit - 1
            ? { choice: "finish" }
            : await judge.decide(state, signal);
        signal.throwIfAborted();
        this.store.runs.host.advance(parent, decision.choice);
      }
    }
    if (signal.reason === timeout) return;
    this.throwAbortReason(signal);
    this.store.runs.finish(
      parent.id,
      signal.reason instanceof AppError && signal.reason.code === "unknown"
        ? "unknown"
        : signal.aborted
          ? "cancelled"
          : failed
            ? "failed"
            : "completed",
      failed ? "群聊存在失败成员或已达到执行上限，请查看成员执行记录。" : null,
    );
  }
  private async perform(job: Job, signal: AbortSignal, agent: Agent) {
    const workspace = join(this.workspaces, job.botId);
    await mkdir(workspace, { recursive: true });
    let text = job.text;
    let pending = job.attachments;
    let threadId = job.threadId;
    const context = new ContextManager(this.store);
    const stream = new StreamBuffer((entries) =>
      this.store.runs.output.writeStream(job, entries),
    );
    const emit = (event: AgentEvent) => {
      if (signal.aborted) return;
      const itemId =
        "itemId" in event
          ? job.groupOrdinal === undefined
            ? event.itemId
            : `${job.groupOrdinal}:${event.itemId}`
          : "";
      if (event.type === "text") {
        stream.text(itemId, event.text, event.complete);
        return;
      }
      if (event.type === "tool-output") {
        stream.toolOutput(itemId, event.delta);
        return;
      }
      // [Invariant]: 状态类事件先排空增量，保证落库顺序与事件顺序一致。
      stream.flush();
      if (event.type === "tool")
        this.store.runs.output.writeTool(job, itemId, event.tool);
      if (event.type === "thread")
        this.store.runs.setThread(job, event.threadId);
      if (event.type === "turn") this.store.runs.setTurn(job, event.turnId);
      if (event.type === "file")
        this.store.files.saveAgentFile(job, event.name, event.data);
    };
    const output = groupOutput(emit);
    const loop = async () => {
      for (;;) {
        // Each continuation closes its tool scope before the run can be sealed,
        // so a follow-up accepted while the turn unwinds is still on this run.
        const scope = this.store.runs.host.info(job.id)?.ending
          ? undefined
          : this.tools?.open({ ...job, text, attachments: pending }, signal);
        let result: AgentResult;
        try {
          signal.throwIfAborted();
          if (job.groupOrdinal === undefined)
            threadId = this.store.runs.conversationThread(job.conversationId);
          const rules = () =>
            job.description +
            this.store.memoryOperations.memoryContext(job) +
            this.store.files.directoryContext(job.conversationId) +
            this.store.routineOperations.routineContext(job);
          const freshSession =
            (await agent.requiresFreshSession?.(threadId, workspace)) ?? false;
          const prepared = await context.prepare(
            { ...job, attachments: pending },
            threadId,
            () =>
              text +
              (scope
                ? skillDiscoveryContext(
                    this.store.toolOperations.skillDiscoveryCatalog(job),
                  )
                : ""),
            rules,
            workspace,
            signal,
            false,
            freshSession,
          );
          const attachments = pending.length
            ? await materializeAttachments(
                this.store,
                this.workspaces,
                workspace,
                { ...job, text, attachments: pending, threadId },
                signal,
              )
            : [];
          signal.throwIfAborted();
          result = await agent.run({
            runId: job.id,
            isRunCancelled: (runId) =>
              this.store.runs.getRun(runId)?.status === "cancelled",
            sessionScope: {
              conversationId: job.conversationId,
              botId: job.botId,
            },
            threadId,
            restartThread: prepared.restartThread,
            text: prepared.text,
            instructions:
              prepared.rules +
              prepared.context +
              (threadId && !prepared.restartThread
                ? ""
                : this.store.runs.historyContext(job)),
            workspace,
            signal,
            attachments,
            ...(scope ? { toolAccess: scope.connection } : {}),
            onEvent:
              job.groupOrdinal === undefined
                ? emit
                : (event) => output.accept(event),
          });
        } finally {
          await scope?.close();
        }
        if (
          result.status !== "completed" ||
          job.groupOrdinal !== undefined ||
          signal.aborted
        )
          return { ...result, contributed: output.contributed, settled: false };
        await new Promise<void>((resolve) => {
          queueMicrotask(resolve);
        });
        if (signal.aborted)
          return { ...result, contributed: output.contributed, settled: false };
        // [Invariant]: settlePrivateTurn 可能直接写入终态，落库必须先完成。
        stream.flush();
        const decision = this.store.runs.settlePrivateTurn(job);
        if (decision.action === "steer") {
          text = decision.text;
          pending = decision.attachments;
          continue;
        }
        return {
          ...result,
          contributed: output.contributed,
          settled: decision.action === "completed",
        };
      }
    };
    let failed = false;
    try {
      return await loop();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // 失败或超时后的迟到事件不再进入 Store；真正的库故障会在写入终态时再次暴露。
      if (failed || signal.aborted) stream.closeQuietly();
      else stream.close();
    }
  }
  async stop() {
    this.stopping = true;
    for (const active of this.active.values()) active.controller.abort();
    await this.loop;
    await Promise.all(
      [...this.active.values()].map((active) => active.finished),
    );
  }
  async quiesce(runIds: readonly string[]) {
    const targets = [...this.active.values()].filter((active) =>
      runIds.includes(active.job.id),
    );
    for (const active of targets) active.controller.abort();
    await Promise.all(targets.map((active) => active.finished));
  }
}
