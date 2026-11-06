import { workerRoutes } from "../shared/protocol.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { failureSchema } from "../shared/core.js";
import {
  routineOperationSchema,
  routineToolResultSchema,
} from "../shared/routines.js";
import {
  skillOperationSchema,
  skillToolResultSchema,
} from "../shared/tools/skill-tools.js";
import {
  templateOperationSchema,
  templateToolResultSchema,
} from "../shared/templates/template-tools.js";
export function registerConfigurationTools({
  server,
  port,
  token,
  shutdown,
}: {
  server: McpServer;
  port: number;
  token: string;
  shutdown: AbortController;
}) {
  server.registerTool(
    "templates",
    {
      description:
        "Create and edit LOCAL template drafts in this Bot's user-initiated private chat. list/read access only drafts owned by this Bot. create captures this Bot's configuration with explicitly chosen skills and paused task definitions, then applies name, description and tags. update changes only those metadata fields using the current revision. Every mutation creates a persisted chat card. This tool CANNOT publish, revoke, import or delete. Ask the user to review the card and publish in the template manager. Never claim a draft is published. Group and automatic runs cannot access private templates.",
      inputSchema: z.object({ operation: templateOperationSchema }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ operation }, ctx) => {
      const response = await fetch(
        `http://127.0.0.1:${port}${workerRoutes.toolsTemplates}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ callId: String(ctx.mcpReq.id), operation }),
          signal: AbortSignal.any([
            shutdown.signal,
            ctx.mcpReq.signal,
            AbortSignal.timeout(30000),
          ]),
        },
      );
      if (!response.body)
        throw Error("Template result was not confirmed; inspect saved drafts.");
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2 * 1024 * 1024 + 16384)
            throw Error(
              "Template response exceeded limit; inspect saved drafts.",
            );
          chunks.push(chunk.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!response.ok) {
        const failure = z.object({ error: failureSchema }).parse(value);
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(failure.error) }],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(templateToolResultSchema.parse(value)),
          },
        ],
      };
    },
  );
  server.registerTool(
    "routines",
    {
      description:
        "Manage this Bot's real scheduled tasks when requested in a user-initiated private chat. list returns summaries; read returns exact instructions; create saves an ACTIVE definition and update preserves its enabled state unless enabled is supplied. Choose the schedule from the user's intent: execute now without this tool; for a relative delay such as 'in 3 minutes' use delay with seconds (the server computes the time, never construct an absolute at from a UTC clock plus a local offset); use at with an ISO 8601 time and offset for one future absolute time; use a five-field cron with an explicit IANA time zone for recurring work; or webhook for external events. Ask for a missing time, time zone or trigger instead of guessing. update/pause/delete require the current revision. Every mutation creates a visible task receipt. Tell the user the task is active and can be paused or tested from its card. This tool cannot test, reveal keys, or operate from groups or automatic runs. Unknown writes must be inspected before any new mutation.",
      inputSchema: z.object({ operation: routineOperationSchema }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ operation }, ctx) => {
      const response = await fetch(
        `http://127.0.0.1:${port}${workerRoutes.toolsRoutines}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ callId: String(ctx.mcpReq.id), operation }),
          signal: AbortSignal.any([
            shutdown.signal,
            ctx.mcpReq.signal,
            AbortSignal.timeout(30000),
          ]),
        },
      );
      const text = await response.text();
      if (Buffer.byteLength(text) > 512 * 1024)
        throw Error(
          "Routine result exceeded limit; inspect saved state before retrying",
        );
      if (!response.ok) {
        const failure = z
          .object({ error: failureSchema })
          .safeParse(JSON.parse(text));
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: failure.success
                ? JSON.stringify(failure.data.error)
                : "Routine change was not confirmed. Inspect the task manager before a new write.",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              routineToolResultSchema.parse(JSON.parse(text)),
            ),
          },
        ],
      };
    },
  );
  server.registerTool(
    "skills",
    {
      description:
        "Create, update or delete reusable skills only when requested by the user. Discover skills with read /skills and read the exact versioned SKILL.md path before using or editing it. create saves name, description (when to use), and full body. update/delete require the current id and revision from the directory. All writes create a visible version record. Group conversations cannot modify private skills. Saved content grants no permissions and does not run automatically. Inspect /skills after an unknown result; never blindly retry writes.",
      inputSchema: z
        .object({
          operation: z.discriminatedUnion("action", [
            skillOperationSchema.options[2],
            skillOperationSchema.options[3],
            skillOperationSchema.options[4],
          ]),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ operation }, ctx) => {
      const response = await fetch(
        `http://127.0.0.1:${port}${workerRoutes.toolsSkills}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ callId: String(ctx.mcpReq.id), operation }),
          signal: AbortSignal.any([
            shutdown.signal,
            ctx.mcpReq.signal,
            AbortSignal.timeout(30000),
          ]),
        },
      );
      const text = await response.text();
      if (Buffer.byteLength(text) > 512 * 1024)
        throw Error(
          "Skill tool result exceeded limit; inspect saved state before retrying",
        );
      if (!response.ok) {
        const failure = z
          .object({ error: failureSchema })
          .safeParse(JSON.parse(text));
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: failure.success
                ? JSON.stringify(failure.data.error)
                : "Skill request was not confirmed. Inspect the catalog and application records before a new write.",
            },
          ],
        };
      }
      const result = skillToolResultSchema.parse(JSON.parse(text));
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
