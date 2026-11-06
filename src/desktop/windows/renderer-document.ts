import { net, type Session } from "electron";
import { dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Preserve the document CSP and limit file resources to the renderer directory. */
export function serveRendererDocument(session: Session, page: string) {
  const root = dirname(fileURLToPath(page));
  session.protocol.handle("file", async (request) => {
    const path = relative(root, fileURLToPath(request.url));
    if (
      isAbsolute(path) ||
      path === ".." ||
      path.startsWith("../") ||
      path.startsWith("..\\")
    )
      return new Response("Forbidden", { status: 403 });
    return net.fetch(request.url, {
      bypassCustomProtocolHandlers: true,
    });
  });
}
