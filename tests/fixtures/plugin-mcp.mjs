import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize")
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1.0" },
    };
  else if (request.method === "tools/list")
    result = {
      tools: [
        {
          name: "echo",
          description: "fixture echo",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" }, slow: { type: "boolean" } },
          },
        },
      ],
    };
  else if (request.method === "tools/call") {
    appendFileSync(
      process.env.EFFECT_PATH,
      `${JSON.stringify(request.params)}\n`,
    );
    if (request.params.arguments?.slow) continue;
    result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            text: request.params.arguments?.text,
            inheritedSecret: process.env.ASTER_TOOL_TOKEN ?? null,
            pluginRoot: process.cwd(),
          }),
        },
      ],
    };
  } else if (request.method === "ping") result = {};
  else {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } })}\n`,
    );
    continue;
  }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
  );
}
