import type { AgentConnection } from "../../../shared/agent-connections.js";

export type ProviderPreset = {
  id: string;
  name: string;
  group: "模型厂商" | "第三方平台" | "本地模型";
  description: string;
  modelHint: string;
  env: string;
  api?: AgentConnection["api"];
  baseUrl?: string;
};

// Model hints are examples from the installed Pi catalog, not a remote model list.
export const providerPresets: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    group: "模型厂商",
    description: "api.openai.com",
    modelHint: "gpt-5.4",
    env: "OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    group: "模型厂商",
    description: "api.anthropic.com",
    modelHint: "claude-sonnet-4-6",
    env: "ANTHROPIC_API_KEY",
  },
  {
    id: "google",
    name: "Google Gemini",
    group: "模型厂商",
    description: "generativelanguage.googleapis.com",
    modelHint: "gemini-3.8-flash",
    env: "GEMINI_API_KEY",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    group: "模型厂商",
    description: "api.deepseek.com",
    modelHint: "deepseek-v4-pro",
    env: "DEEPSEEK_API_KEY",
  },
  {
    id: "xai",
    name: "xAI",
    group: "模型厂商",
    description: "api.x.ai",
    modelHint: "grok-4.7",
    env: "XAI_API_KEY",
  },
  {
    id: "mistral",
    name: "Mistral",
    group: "模型厂商",
    description: "api.mistral.ai",
    modelHint: "mistral-small-latest",
    env: "MISTRAL_API_KEY",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    group: "第三方平台",
    description: "openrouter.ai",
    modelHint: "提供商/模型 ID",
    env: "OPENROUTER_API_KEY",
  },
  {
    id: "groq",
    name: "Groq",
    group: "第三方平台",
    description: "api.groq.com",
    modelHint: "openai/gpt-oss-120b",
    env: "GROQ_API_KEY",
  },
  {
    id: "local",
    name: "本地 OpenAI 兼容",
    group: "本地模型",
    description: "Ollama、LM Studio 等",
    modelHint: "本地已安装的模型 ID",
    env: "",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
  },
];

export function providerDraft(
  preset: ProviderPreset | null,
  connections: AgentConnection[],
): AgentConnection {
  const prefix = preset?.id ?? "custom";
  let id = prefix,
    suffix = 2;
  while (connections.some((entry) => entry.id === id))
    id = `${prefix}-${suffix++}`;
  return {
    id,
    enabled: true,
    provider: prefix,
    model: "",
    api: preset?.api ?? (preset ? "native" : "openai-completions"),
    baseUrl: preset?.baseUrl ?? "",
    auth: preset?.id === "local" ? "none" : "environment",
    apiKeyEnv: preset?.env || (preset?.id === "local" ? "" : "CUSTOM_API_KEY"),
    thinking: "medium",
    contextWindow: 128000,
    maxTokens: 16384,
  };
}
