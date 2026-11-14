import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentConnection } from "../shared/agent-connections.js";
import { AppError } from "../shared/core.js";
import { PiCredentials, type RunCredentials } from "./pi-credentials.js";

export function configureProvider(
  runtime: ModelRuntime,
  entry: AgentConnection,
) {
  if (entry.api !== "native") {
    runtime.registerProvider(entry.provider, {
      baseUrl: entry.baseUrl,
      api: entry.api,
      authHeader: entry.auth !== "none",
      models: [
        {
          id: entry.model,
          name: entry.model,
          api: entry.api,
          reasoning: entry.thinking !== "off",
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: entry.contextWindow,
          maxTokens: entry.maxTokens,
          // Custom Chat Completions gateways may reject the developer role.
          ...(entry.api === "openai-completions"
            ? { compat: { supportsDeveloperRole: false } }
            : {}),
        },
      ],
    });
  } else if (entry.baseUrl)
    runtime.registerProvider(entry.provider, {
      baseUrl: entry.baseUrl,
      authHeader: entry.auth !== "none",
    });
}

/** No global auth, model catalog, config commands or network catalog discovery. */
export async function configuredModel(
  home: string,
  entry: AgentConnection,
  signal: AbortSignal,
  apiKey?: string,
) {
  let scope: RunCredentials | undefined;
  try {
    signal.throwIfAborted();
    scope =
      (entry.auth === "stored" || entry.auth === "chatgpt") &&
      apiKey === undefined
        ? await new PiCredentials(home).scoped(entry.provider, signal)
        : undefined;
    const credentials = scope ?? new InMemoryCredentialStore();
    const credential = await credentials.read(entry.provider, { signal });
    if (
      entry.provider === "openai" &&
      credential?.type === "oauth" &&
      (entry.api !== "native" || entry.baseUrl)
    )
      throw new AppError(
        "invalid_input",
        "ChatGPT 订阅凭据仅可用于官方 OpenAI 原生接口，请清空 Base URL。",
      );
    if (entry.auth === "chatgpt" && credential?.type !== "oauth")
      throw new AppError("unavailable", "请先在连接设置中登录 ChatGPT 订阅。");
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
      refreshOnCreate: false,
      signal,
    });
    configureProvider(runtime, entry);
    if (entry.auth === "chatgpt" && !runtime.getModel("openai", entry.model))
      runtime.registerProvider("openai", {
        models: [
          {
            id: entry.model,
            name: entry.model,
            api: "openai-responses",
            reasoning: entry.thinking !== "off",
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: entry.contextWindow,
            maxTokens: entry.maxTokens,
          },
        ],
      });
    if (entry.provider === "openai" && credential?.type === "oauth") {
      const provider = runtime.getProvider("openai");
      if (!provider)
        throw new AppError("unavailable", "未找到 OpenAI 提供商。");
      // Subscription requests require tools in additional_tools input items.
      // Apply to both bundled and account-only models, retaining native auth.
      const models = runtime.getModels("openai").map((model) => ({
        ...model,
        compat: {
          ...model.compat,
          supportsMidConvoSystemMessages: true,
          supportsAdditionalTools: true,
          supportsToolSearch: false,
        },
      }));
      runtime.registerNativeProvider({
        ...provider,
        getModels: () => models,
        getAllModels: () => models,
      });
    }
    if (entry.auth === "environment" || apiKey !== undefined) {
      const key = apiKey ?? process.env[entry.apiKeyEnv];
      if (!key)
        throw new AppError(
          "unavailable",
          `后端环境变量 ${entry.apiKeyEnv} 未配置；尚未进行推理。`,
        );
      await runtime.setRuntimeApiKey(entry.provider, key, { signal });
    } else if (
      entry.auth === "stored" &&
      !(await credentials.read(entry.provider, { signal }))
    ) {
      throw new AppError(
        "unavailable",
        "本应用尚未保存此提供商认证，请在连接设置中填写 API Key。",
      );
    } else if (entry.auth === "none") {
      if (
        !entry.baseUrl ||
        !["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(entry.baseUrl).hostname,
        )
      )
        throw new AppError("invalid_input", "无认证模式只允许本机模型接口。");
      // Pi's prompt preflight requires a nonempty auth source even for anonymous
      // local APIs. This public sentinel is never sent as an Authorization header.
      const provider = runtime.getProvider(entry.provider);
      if (!provider)
        throw new AppError("unavailable", "未找到本机模型提供商。");
      runtime.registerNativeProvider({
        ...provider,
        auth: {
          apiKey: {
            name: "Anonymous local model",
            check: async () => ({ type: "api_key" }),
            resolve: async () => ({
              auth: {
                apiKey: "aster-local-no-auth",
                headers: { Authorization: null },
              },
            }),
          },
        },
      });
    }
    const model = runtime.getModel(entry.provider, entry.model);
    if (!model)
      throw new AppError(
        "unavailable",
        "Pi 未找到所选模型，请选择有效的提供商模型或配置兼容接口。",
      );
    signal.throwIfAborted();
    return {
      runtime,
      model,
      release: async () => {
        await scope?.close();
      },
    };
  } catch (error) {
    await scope?.close();
    signal.throwIfAborted();
    if (error instanceof AppError) throw error;
    throw new AppError(
      "unavailable",
      "Pi 模型或认证配置无法读取；请检查本应用的提供商与凭据来源。",
    );
  }
}
