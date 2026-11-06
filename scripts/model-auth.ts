import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve, join } from "node:path";
import { z } from "zod";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { PiCredentials } from "../src/agent/pi-credentials.js";
import { configureProvider } from "../src/agent/pi-model.js";
import { modelConfigPath, readAgentConfig } from "../src/agent/config-file.js";

process.env.ASTER_STRICT_SECRETS = "1";
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const home = resolve(
  option("--home") ??
    join(process.env.ASTER_DATA_DIR ?? ".runtime/aster", "agent"),
);
const config = readAgentConfig(modelConfigPath(home)).config;
const selected = config.connections.find(
  (entry) => entry.id === config.defaultAgent,
);
const provider = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,80}$/)
  .parse(option("--provider") ?? selected?.provider);
const type = z.enum(["api_key", "oauth"]).parse(option("--type") ?? "api_key");
const shutdown = new AbortController();
const cancel = () => shutdown.abort();
process.once("SIGINT", cancel);
const runtime = await ModelRuntime.create({
  credentials: new PiCredentials(home),
  modelsPath: null,
  modelsStore: new InMemoryModelsStore(),
  refreshOnCreate: false,
});
const providerConfig =
  selected?.provider === provider
    ? selected
    : config.connections.find((entry) => entry.provider === provider);
if (providerConfig) configureProvider(runtime, providerConfig);
/** Secret prompts never echo typed credentials. */
async function secret(message: string, signal: AbortSignal) {
  if (!stdin.isTTY)
    throw Error("Secret entry requires a trusted interactive terminal");
  stdout.write(message + ": ");
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((accept, reject) => {
      let value = "";
      const dispose = () => {
        stdin.removeListener("data", data);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        dispose();
        reject(new DOMException("Cancelled", "AbortError"));
      };
      const data = (buffer: Buffer) => {
        for (const ch of buffer.toString("utf8")) {
          if (ch === "\u0003") {
            cancel();
            abort();
            return;
          }
          if (ch === "\r" || ch === "\n") {
            dispose();
            accept(value);
            return;
          }
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else if (ch >= " ") value += ch;
        }
      };
      stdin.on("data", data);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write("\n");
  }
}
try {
  await runtime.login(provider, type, {
    signal: shutdown.signal,
    async prompt(prompt) {
      const signal = prompt.signal
        ? AbortSignal.any([shutdown.signal, prompt.signal])
        : shutdown.signal;
      if (prompt.type === "secret") return secret(prompt.message, signal);
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        if (prompt.type === "select")
          for (const item of prompt.options)
            stdout.write(`${item.id}: ${item.label}\n`);
        return await rl.question(prompt.message + ": ", { signal });
      } finally {
        rl.close();
      }
    },
    notify(event) {
      if (event.type === "auth_url")
        stdout.write("在浏览器完成认证：" + event.url + "\n");
      else if (event.type === "device_code")
        stdout.write(event.verificationUri + " 代码：" + event.userCode + "\n");
      else stdout.write(event.message + "\n");
    },
  });
  stdout.write("认证已加密保存到本应用。下一次运行生效。\n");
} catch {
  process.exitCode = 1;
  stdout.write(
    "认证未完成。检查提供商及认证类型，或重试登录；没有输出密钥。\n",
  );
} finally {
  process.removeListener("SIGINT", cancel);
  stdin.pause();
}
