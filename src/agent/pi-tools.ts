import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentInput } from "../chat/agent.js";
import { AppError } from "../shared/core.js";
import { failureSchema } from "../shared/core.js";
import { scriptToolTimeoutMs } from "../shared/tools/scripts.js";

const allowed = [
  "ask_user",
  "skills",
  "routines",
  "notify",
  "templates",
  "read",
  "plugins",
  "shell",
];
const contentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(2 * 1024 * 1024) }),
  z.object({
    type: z.literal("image"),
    mimeType: z.string(),
    data: z.string().max(4 * 1024 * 1024),
  }),
]);
/** The existing MCP server retains all runtime validation, directory grants and approval behavior. */
export async function openPiTools(
  input: AgentInput,
  fail: (error: AppError) => void,
) {
  const client = new Client({ name: "aster-pi", version: "1.0.0" });
  let transport: StdioClientTransport | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      input.signal.removeEventListener("abort", abort);
      try {
        await client.close();
      } finally {
        await transport?.close();
      }
    })());
  const abort = () => {
    void close().catch(() => {});
  };
  try {
    if (!input.toolAccess) return { tools: [], close };
    input.signal.throwIfAborted();
    let entry = fileURLToPath(
      new URL("../tools/mcp-server.js", import.meta.url),
    );
    try {
      await access(entry);
    } catch {
      entry = fileURLToPath(
        new URL("../../dist/tools/mcp-server.js", import.meta.url),
      );
      await access(entry);
    }
    const env: Record<string, string> = {
      ASTER_TOOL_PORT: String(input.toolAccess.port),
      ASTER_TOOL_TOKEN: input.toolAccess.token,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    };
    // Windows process creation requires system environment, never model credentials.
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH"])
      if (process.env[key]) env[key] = process.env[key];
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env,
      stderr: "ignore",
      maxBufferSize: 8 * 1024 * 1024,
    });
    input.signal.addEventListener("abort", abort, { once: true });
    await client.connect(transport, { signal: input.signal, timeout: 15000 });
    const inventory = await client.listTools({}, { signal: input.signal });
    if (
      inventory.tools.length !== allowed.length ||
      inventory.tools.some((tool) => !allowed.includes(tool.name))
    )
      throw new AppError(
        "unauthorized",
        "作用域 MCP 工具清单不匹配，运行未开始。",
      );
    const tools: ToolDefinition[] = inventory.tools.map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? tool.name,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        try {
          const result = await client.callTool(
            {
              name: tool.name,
              arguments: z.record(z.string(), z.unknown()).parse(params),
            },
            {
              signal: signal
                ? AbortSignal.any([signal, input.signal])
                : input.signal,
              timeout: tool.name === "shell" ? scriptToolTimeoutMs : 360000,
            },
          );
          const content = z.array(contentSchema).parse(result.content);
          let confirmedFailure = false;
          for (const block of content) {
            if (block.type !== "text") continue;
            let value: unknown;
            try {
              value = JSON.parse(block.text);
            } catch {
              continue;
            }
            const unknown = z
              .object({ status: z.literal("unknown") })
              .safeParse(value);
            if (unknown.success)
              throw new AppError(
                "unknown",
                "工具执行结果未知，请核实实际状态；未自动重试。",
              );
            const failure = failureSchema.safeParse(value);
            if (failure.success) {
              if (failure.data.code === "unknown")
                throw new AppError(
                  "unknown",
                  "工具执行结果未知，请核实实际状态；未自动重试。",
                );
              confirmedFailure = true;
            }
          }
          if (result.isError && !confirmedFailure)
            throw new AppError("unknown", "工具响应未能确认；请核实实际结果。");
          return { content, details: { isError: result.isError === true } };
        } catch {
          if (input.signal.aborted || signal?.aborted)
            throw new DOMException("Tool cancelled", "AbortError");
          const error = new AppError(
            "unknown",
            "授权工具的结果未能确认，请核实实际状态；运行已停止，未自动重试。",
          );
          fail(error);
          throw error;
        }
      },
    }));
    input.signal.throwIfAborted();
    return { tools, close };
  } catch (error) {
    await close();
    throw error;
  }
}
