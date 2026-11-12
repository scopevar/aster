import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import type {
  ChatGPTAuthRequest,
  ChatGPTAuthReply,
} from "../shared/chatgpt-auth.js";
import { AppError } from "../shared/core.js";
import type { PiCredentials } from "./pi-credentials.js";

type Attempt = {
  id: string;
  controller: AbortController;
  url?: string;
  done: Promise<void>;
};
const catalogSchema = z.object({
  models: z
    .array(
      z.object({
        slug: z.string().min(1).max(160),
        display_name: z.string().min(1).max(200),
        visibility: z.string(),
      }),
    )
    .max(1000),
});

/** Owns only Aster's explicit OpenAI login, never a global Codex/Pi session. */
export class ChatGPTAuth {
  private attempt: Attempt | undefined;
  private state: ChatGPTAuthReply["state"] = "idle";
  private message = "";
  private models: ChatGPTAuthReply["models"] = [];
  private closed = false;
  constructor(
    private readonly home: string,
    private readonly credentials: PiCredentials,
    private readonly changed: () => void,
  ) {}
  get active() {
    return this.attempt !== undefined;
  }
  private async deviceId() {
    await mkdir(this.home, { recursive: true });
    const path = join(this.home, "chatgpt-host-id");
    try {
      await writeFile(path, randomUUID(), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
    return z.uuid().parse(await readFile(path, "utf8"));
  }
  private async status(): Promise<ChatGPTAuthReply> {
    const credentialType =
      (await this.credentials.list()).find(
        (entry) => entry.providerId === "openai",
      )?.type ?? "none";
    const authenticated = credentialType === "oauth";
    if (this.state === "connected" && !authenticated) {
      this.state = "idle";
      this.message = "";
      this.models = [];
    }
    return {
      state: this.state === "idle" && authenticated ? "connected" : this.state,
      authenticated,
      credentialType,
      message: this.message,
      models: authenticated ? this.models : [],
      ...(this.attempt ? { id: this.attempt.id } : {}),
    };
  }
  async request(
    value: ChatGPTAuthRequest,
    signal: AbortSignal,
  ): Promise<ChatGPTAuthReply> {
    signal.throwIfAborted();
    if (this.closed) throw new AppError("unavailable", "后台正在退出。");
    if (value.action === "status") return this.status();
    if (value.action === "cancel") {
      if (this.attempt?.id === value.id) {
        this.attempt.controller.abort();
        await this.attempt.done;
      }
      return this.status();
    }
    if (value.action === "logout") {
      const attempt = this.attempt;
      attempt?.controller.abort();
      await attempt?.done;
      // A saved API key is a separate authentication method; don't delete it.
      if ((await this.credentials.read("openai"))?.type === "oauth") {
        await this.credentials.delete("openai", { signal });
        this.changed();
      }
      this.state = "idle";
      this.message = "已退出本机 ChatGPT 登录。";
      this.models = [];
      return this.status();
    }
    if (this.attempt) throw new AppError("conflict", "ChatGPT 登录正在进行。");
    const attempt: Attempt = {
      id: value.id,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.attempt = attempt;
    this.state = "pending";
    this.message = "请在系统浏览器中完成 ChatGPT 授权。";
    let ready!: () => void;
    const opened = new Promise<void>((resolve) => {
      ready = resolve;
    });
    attempt.done = this.login(attempt, ready);
    const abort = () => attempt.controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await opened;
      signal.throwIfAborted();
      return {
        ...(await this.status()),
        ...(attempt.url ? { authorizationUrl: attempt.url } : {}),
      };
    } catch (error) {
      attempt.controller.abort();
      await attempt.done;
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private async login(attempt: Attempt, ready: () => void) {
    const signal = AbortSignal.any([
      attempt.controller.signal,
      AbortSignal.timeout(5 * 60_000),
    ]);
    try {
      const deviceId = await this.deviceId();
      const staged = new InMemoryCredentialStore();
      const runtime = await ModelRuntime.create({
        credentials: staged,
        modelsPath: null,
        modelsStore: new InMemoryModelsStore(),
        refreshOnCreate: false,
        signal,
      });
      const credential = await runtime.login(
        "openai",
        "oauth",
        {
          signal,
          notify: (event) => {
            if (event.type === "auth_url") {
              attempt.url = event.url;
              ready();
            }
          },
          // Pi's manual fallback races the loopback listener. The desktop uses the
          // listener; this branch remains pending until Pi cancels the fallback.
          prompt: (prompt) =>
            new Promise<string>((_resolve, reject) => {
              const promptSignal = prompt.signal
                ? AbortSignal.any([signal, prompt.signal])
                : signal;
              const abort = () =>
                reject(new DOMException("Cancelled", "AbortError"));
              if (promptSignal.aborted) abort();
              else
                promptSignal.addEventListener("abort", abort, { once: true });
            }),
        },
        { getDeviceId: () => deviceId, agentName: "Aster" },
      );
      let message = "已连接 ChatGPT 订阅。";
      let models: ChatGPTAuthReply["models"] = [];
      try {
        const auth = await runtime.getAuth("openai", { signal });
        const response = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${auth?.auth.apiKey}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) throw Error("Model catalog unavailable");
        models = catalogSchema
          .parse(await response.json())
          .models.filter((model) => model.visibility === "list")
          .map((model) => ({ id: model.slug, name: model.display_name }));
      } catch {
        message =
          "已连接 ChatGPT 订阅，模型列表暂不可用，可填写模型 ID 后测试。";
      }
      signal.throwIfAborted();
      await this.credentials.modify(
        "openai",
        async () => {
          signal.throwIfAborted();
          return credential;
        },
        { signal },
      );
      this.changed();
      this.state = "connected";
      this.message = message;
      this.models = models;
    } catch (error) {
      this.state = attempt.controller.signal.aborted ? "idle" : "error";
      this.message = attempt.controller.signal.aborted
        ? "已取消登录。"
        : signal.aborted
          ? "ChatGPT 登录超时，请重试。"
          : error instanceof Error &&
              "code" in error &&
              error.code === "EADDRINUSE"
            ? "登录回调端口 1455 已占用，请结束其他登录后重试。"
            : "ChatGPT 登录未完成。请检查网络、订阅权限及回调端口 1455 后重试。";
    } finally {
      if (this.attempt === attempt) this.attempt = undefined;
      ready();
    }
  }
  async close() {
    this.closed = true;
    this.attempt?.controller.abort();
    await this.attempt?.done;
  }
}
