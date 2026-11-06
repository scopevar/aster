import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import { agentConnectionSchema } from "../../src/shared/agent-connections.js";
const requestSchema = z.object({
  messages: z.array(
    z
      .object({ role: z.string(), content: z.unknown().optional() })
      .passthrough(),
  ),
  model: z.string(),
  tools: z
    .array(z.object({ function: z.object({ name: z.string() }) }))
    .optional(),
});
export type PiWireRequest = z.infer<typeof requestSchema>;
/** Deterministic wire fixture, not real-provider acceptance. Production Pi consumes these SSE responses. */
export async function piModelServer(
  respond?: (
    request: PiWireRequest,
    send: (delta: unknown, finish?: string | null) => void,
    response: ServerResponse,
  ) => void,
) {
  const requests: PiWireRequest[] = [];
  const headers: IncomingHttpHeaders[] = [];
  const errors: unknown[] = [];
  const server = createServer((req, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = requestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      requests.push(request);
      headers.push(req.headers);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta: unknown, finish: string | null = null) => {
        response.write(
          "data: " +
            JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{ index: 0, delta, finish_reason: finish }],
            }) +
            "\n\n",
        );
        if (finish) response.end("data: [DONE]\n\n");
      };
      if (respond) respond(request, send, response);
      else {
        send({ role: "assistant", content: "Hello " });
        send({ content: "Pi" });
        send({}, "stop");
      }
    })().catch((error: unknown) => {
      errors.push(error);
      response.destroy();
    });
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No model port");
  return {
    requests,
    headers,
    connection: agentConnectionSchema.parse({
      id: "fixture",
      provider: "fixture",
      model: "fixture",
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      auth: "none",
      thinking: "off",
    }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
      if (errors.length) throw errors[0];
    },
  };
}
