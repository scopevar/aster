import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { jevConfigSchema } from "../../src/shared/chat/group-host.js";

const requestSchema = z.object({
  model: z.string(),
  state: z.unknown(),
  questions: z.object({
    next: z.object({
      type: z.literal("choice"),
      instructions: z.string(),
      criteria: z.record(z.string(), z.string()),
    }),
  }),
});
export type JevWireRequest = z.infer<typeof requestSchema>;

/** Controlled model responses over the real native HTTP boundary. */
export async function jevServer(
  respond: (request: JevWireRequest, response: ServerResponse) => void,
) {
  const requests: JevWireRequest[] = [];
  const authorizations: (string | undefined)[] = [];
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url !== "/v1/systemone")
        throw Error("Unexpected Jev endpoint");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = requestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      requests.push(body);
      authorizations.push(request.headers.authorization);
      respond(body, response);
    })().catch((error: unknown) => {
      errors.push(error);
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing Jev port");
  return {
    requests,
    authorizations,
    config: jevConfigSchema.parse({
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (errors.length) throw errors[0];
    },
  };
}

export function jevAnswer(
  response: ServerResponse,
  choice: string,
  confidence = 1,
) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      answers: {
        next: {
          type: "choice",
          choice,
          confidence,
          probabilities: { [choice]: 1 },
        },
      },
    }),
  );
}
