import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { z } from "zod";

async function text(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response
    .writeHead(status, {
      "Content-Type": "application/json",
      Connection: "close",
    })
    .end(JSON.stringify(value));
}
async function listen(
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
) {
  const server = createServer((request, response) => {
    void handle(request, response).catch(() =>
      json(response, { error: "fixture_failure" }, 500),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

/** Real OAuth HTTP endpoints on a different origin from the protected MCP resource. */
export async function pluginOAuthFixture(transport: "http" | "sse" = "http") {
  const clients = new Map<string, string>();
  const codes = new Map<
    string,
    { challenge: string; redirect: string; client: string }
  >();
  let token = "",
    refresh = "",
    performed = 0,
    refreshes = 0,
    exchanges = 0;
  let wrongIssuer = false,
    deny = false,
    heldToken = false;
  let release: (() => void) | undefined;
  const leakedHeaders: string[] = [];
  let events: ServerResponse | undefined;
  let mcpOrigin = "",
    authOrigin = "";
  const authorization = await listen(async (request, response) => {
    if (request.headers["x-plugin-secret"])
      leakedHeaders.push(String(request.headers["x-plugin-secret"]));
    const url = new URL(request.url ?? "/", authOrigin);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(response, {
        issuer: authOrigin,
        authorization_endpoint: `${authOrigin}/authorize`,
        token_endpoint: `${authOrigin}/token`,
        registration_endpoint: `${authOrigin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
      return;
    }
    if (url.pathname === "/register") {
      const input = z
        .object({ redirect_uris: z.array(z.url()).min(1) })
        .parse(JSON.parse(await text(request)));
      const redirect = input.redirect_uris[0];
      assert.ok(redirect);
      const client = randomUUID();
      clients.set(client, redirect);
      json(response, {
        ...input,
        client_id: client,
        token_endpoint_auth_method: "none",
      });
      return;
    }
    if (url.pathname === "/authorize") {
      const client = url.searchParams.get("client_id") ?? "",
        redirect = url.searchParams.get("redirect_uri") ?? "";
      assert.equal(clients.get(client), redirect);
      assert.equal(url.searchParams.get("resource"), `${mcpOrigin}/mcp`);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const challenge = url.searchParams.get("code_challenge");
      assert.ok(challenge);
      const code = randomUUID();
      codes.set(code, { challenge, redirect, client });
      const target = new URL(redirect);
      target.searchParams.set("state", url.searchParams.get("state") ?? "");
      target.searchParams.set(
        "iss",
        wrongIssuer ? `${authOrigin}/wrong` : authOrigin,
      );
      target.searchParams.set(
        deny ? "error" : "code",
        deny ? "access_denied" : code,
      );
      response
        .writeHead(302, { Location: target.href, Connection: "close" })
        .end();
      return;
    }
    if (url.pathname === "/token") {
      const input = new URLSearchParams(await text(request));
      assert.equal(input.get("resource"), `${mcpOrigin}/mcp`);
      if (input.get("grant_type") === "authorization_code") {
        exchanges++;
        const code = input.get("code") ?? "",
          issued = codes.get(code);
        assert.ok(issued);
        assert.equal(input.get("client_id"), issued.client);
        assert.equal(input.get("redirect_uri"), issued.redirect);
        assert.equal(
          createHash("sha256")
            .update(input.get("code_verifier") ?? "")
            .digest("base64url"),
          issued.challenge,
        );
        codes.delete(code);
      } else {
        assert.equal(input.get("grant_type"), "refresh_token");
        if (input.get("refresh_token") !== refresh) {
          json(response, { error: "invalid_grant" }, 400);
          return;
        }
        refreshes++;
      }
      if (heldToken)
        await new Promise<void>((resolve) => {
          release = resolve;
          request.on("close", resolve);
        });
      token = `access-${randomUUID()}`;
      refresh = `refresh-${randomUUID()}`;
      json(response, {
        access_token: token,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 60,
        scope: "tools:read",
      });
      return;
    }
    json(response, {}, 404);
  });
  authOrigin = authorization.origin;
  const protectedResource = await listen(async (request, response) => {
    const url = new URL(request.url ?? "/", mcpOrigin);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json(response, {
        resource: `${mcpOrigin}/mcp`,
        authorization_servers: [authOrigin],
        scopes_supported: ["tools:read"],
      });
      return;
    }
    if (!token || request.headers.authorization !== `Bearer ${token}`) {
      response
        .writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource", scope="tools:read"`,
          Connection: "close",
        })
        .end();
      return;
    }
    if (request.method === "GET") {
      if (transport === "sse") {
        events = response;
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        response.write("event: endpoint\ndata: /messages\n\n");
        return;
      }
      response.writeHead(405).end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    const message = z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(JSON.parse(await text(request)));
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown = {};
    if (message.method === "initialize")
      result = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "oauth-fixture", version: "1" },
      };
    if (message.method === "tools/list")
      result = {
        tools: [{ name: "protected", inputSchema: { type: "object" } }],
      };
    if (message.method === "tools/call") {
      performed++;
      result = { content: [{ type: "text", text: "authorized result" }] };
    }
    const reply = { jsonrpc: "2.0", id: message.id, result };
    if (transport === "sse") {
      response.writeHead(202).end();
      events?.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    } else json(response, reply);
  });
  mcpOrigin = protectedResource.origin;
  return {
    url: `${mcpOrigin}/mcp`,
    get token() {
      return token;
    },
    get refresh() {
      return refresh;
    },
    get performed() {
      return performed;
    },
    get refreshes() {
      return refreshes;
    },
    get exchanges() {
      return exchanges;
    },
    leakedHeaders,
    expire() {
      token = `expired-${randomUUID()}`;
    },
    rejectRefresh() {
      refresh = "revoked";
    },
    wrongIssuer() {
      wrongIssuer = true;
    },
    deny() {
      deny = true;
    },
    holdToken() {
      heldToken = true;
    },
    async approve(url: string) {
      const response = await fetch(url, { redirect: "manual" });
      const target = response.headers.get("location");
      assert.ok(target);
      return { target, response: await fetch(target) };
    },
    async close() {
      release?.();
      for (const { server } of [protectedResource, authorization]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
