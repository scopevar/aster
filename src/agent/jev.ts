import { join } from "node:path";
import { z } from "zod";
import { AppError } from "../shared/core.js";
import { jevConfigSchema, type JevConfig } from "../shared/chat/group-host.js";
import { PiCredentials } from "./pi-credentials.js";

const answerSchema = z.object({
  answers: z.object({
    next: z.object({
      type: z.literal("choice"),
      choice: z.string(),
      confidence: z.number().min(0).max(1),
      probabilities: z.record(z.string(), z.number().min(0).max(1)),
    }),
  }),
});

/** The caller supplies a closed set of actions; Jev never executes an action itself. */
export class JevClient {
  constructor(
    private readonly config: JevConfig,
    private readonly key: string,
  ) {}
  async choose(
    state: unknown,
    criteria: Record<string, string>,
    instructions: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    try {
      const response = await fetch(
        `${this.config.baseUrl.replace(/\/+$/, "")}/systemone`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.model,
            state,
            questions: { next: { type: "choice", instructions, criteria } },
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          "unavailable",
          `Jev 请求失败（HTTP ${response.status}），请检查地址、密钥和模型配置。`,
        );
      }
      if (!response.body)
        throw new AppError("unavailable", "Jev 未返回判断结果。");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536)
            throw new AppError("capacity", "Jev 响应超过大小限制。");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const parsed = answerSchema.safeParse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (!parsed.success)
        throw new AppError("unavailable", "Jev 返回的判断格式无效。");
      const answer = parsed.data.answers.next;
      if (
        !Object.hasOwn(criteria, answer.choice) ||
        Object.keys(answer.probabilities).some(
          (key) => !Object.hasOwn(criteria, key),
        )
      )
        throw new AppError("unavailable", "Jev 返回了候选范围以外的判断。");
      const probabilities = Object.values(answer.probabilities);
      if (
        answer.probabilities[answer.choice] !== Math.max(...probabilities) ||
        Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) >
          0.01
      )
        throw new AppError("unavailable", "Jev 返回的概率分布无效。");
      return answer;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AppError) throw error;
      throw new AppError(
        "unavailable",
        "Jev 连接超时、不可用或响应无效，本次判断未完成。",
      );
    }
  }
}

export class JevConnection {
  private readonly credentials: PiCredentials;
  constructor(home: string) {
    this.credentials = new PiCredentials(join(home, "jev"));
  }
  async hasKey() {
    return (await this.credentials.list()).some(
      (entry) => entry.providerId === "typesafe",
    );
  }
  async saveKey(key: string) {
    await this.credentials.modify("typesafe", async () => ({
      type: "api_key",
      key,
    }));
  }
  async client(config: JevConfig, key?: string) {
    const credential = key
      ? undefined
      : await this.credentials.read("typesafe");
    const resolved =
      key ?? (credential?.type === "api_key" ? credential.key : undefined);
    if (!resolved)
      throw new AppError(
        "unavailable",
        "请在设置 → 模型与连接 → Jev 辅助决策中填写 API Key。",
      );
    return new JevClient(jevConfigSchema.parse(config), resolved);
  }
  async test(config: JevConfig, key: string | undefined, signal: AbortSignal) {
    const client = await this.client(config, key);
    const result = await client.choose(
      { status: "ready" },
      { ready: "状态为 ready", other: "其他状态" },
      "判断 state.status 是否为 ready。",
      signal,
    );
    if (result.choice !== "ready")
      throw new AppError("unavailable", "Jev 已连接，但未通过简单判断测试。");
  }
}
