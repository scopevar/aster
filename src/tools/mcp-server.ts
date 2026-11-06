import { registerPluginTools } from "./plugin-tools.js";
import { McpServer } from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { registerConfigurationTools } from "./configuration-tools.js";
import { registerReadTool } from "./content-tools.js";
import { registerInteractiveTools } from "./interactive-tools.js";
import { registerNotificationTools } from "./notification-tools.js";
import { registerShellTool } from "./script-tools.js";

const port = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65535)
  .parse(process.env.ASTER_TOOL_PORT);
const token = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .parse(process.env.ASTER_TOOL_TOKEN);
delete process.env.ASTER_TOOL_TOKEN;
const shutdown = new AbortController();
process.stdin.once("end", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());
serveStdio(
  () => {
    const server = new McpServer(
      { name: "aster-desktop", version: "1.0.0" },
      {
        instructions:
          "Use shell for Bash/Python/Node in this Bot's Microsandbox VM and read for scoped files, images, skill instructions and archived history. Process documents with Python. Applications provide ask_user, skill mutations, routines, templates, plugins and background notify. Every shell command requires approval. Discovery grants no permission. Verify unknown side effects before retrying. Group inputs and skills expose only received content. Never expose scoped credentials.",
      },
    );
    registerPluginTools({ server, port, token, shutdown });
    registerReadTool({ server, port, token, shutdown });
    registerConfigurationTools({ server, port, token, shutdown });
    registerNotificationTools({ server, port, token, shutdown });
    registerShellTool({ server, port, token, shutdown });
    registerInteractiveTools({ server, port, token, shutdown });
    return server;
  },
  {
    transport: new StdioServerTransport(undefined, undefined, {
      maxBufferSize: 256 * 1024,
    }),
  },
);
