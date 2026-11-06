import type { Page } from "@playwright/test";
import { test, expect } from "../helpers/desktop-test.js";
import { readFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { diagnosticsSchema } from "../../src/shared/diagnostics.js";
import { callWorker, readWorker } from "../../src/worker/client.js";
import { workerRoutes } from "../../src/shared/protocol.js";
import { resultSchema } from "../../src/shared/core.js";
import { openDesktop } from "../helpers/local-desktop.js";

async function diagnose(page: Page, action: "inspect" | "save") {
  const result = await page.evaluate(
    (action) =>
      window.aster.diagnostics({ requestId: crypto.randomUUID(), action }),
    action,
  );
  if (!result.success) throw Error(result.error.message);
  return result.data;
}

test("diagnostic IPC reads real state and exports safe files, with native picker result fixtures only", async ({
  desktop,
}) => {
  const directory = desktop.directory;
  const app = await desktop.launch({});
  await app.context().tracing.start({ screenshots: true, snapshots: true });
  try {
    const page = await openDesktop(app);
    const endpoint = await readWorker(directory);
    const secret = `PRIVATE_${randomUUID()}`;
    resultSchema.parse(
      await callWorker(endpoint, workerRoutes.command, {
        id: randomUUID(),
        command: { type: "bot.create", name: "诊断验收", description: secret },
      }),
    );
    const inspected = await diagnose(page, "inspect");
    if (inspected.status !== "inspected")
      throw Error("Missing diagnostic report");
    const shown = diagnosticsSchema.parse(inspected.report);
    expect(shown.worker.available).toBe(true);
    if (shown.worker.available)
      expect(shown.worker.data.storage.records).toMatchObject({
        bots: 1,
        conversations: 1,
        messages: 0,
      });
    expect(JSON.stringify(shown)).not.toContain(secret);
    expect(JSON.stringify(shown)).not.toContain(endpoint.token);
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
    });
    expect(await diagnose(page, "save")).toEqual({ status: "cancelled" });
    const output = join(directory, "report.json");
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, output);
    expect(await diagnose(page, "save")).toMatchObject({
      status: "saved",
      name: "report.json",
    });
    const bytes = await readFile(output, "utf8");
    const saved = diagnosticsSchema.parse(JSON.parse(bytes));
    expect(saved.worker.available).toBe(true);
    expect(bytes).not.toContain(secret);
    await page.screenshot({ path: test.info().outputPath("diagnostic.png") });
    const invalid = join(directory, "cannot-replace.json");
    await mkdir(invalid);
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, invalid);
    expect(
      await page.evaluate(() =>
        window.aster.diagnostics({
          requestId: crypto.randomUUID(),
          action: "save",
        }),
      ),
    ).toEqual({
      success: false,
      error: { code: "unknown", message: "操作结果未能确认，请重试。" },
    });
    expect(await readFile(output, "utf8")).toBe(bytes);
    const endpointPath = join(directory, "endpoint.json");
    const hiddenEndpoint = join(directory, "endpoint-held.json");
    await rename(endpointPath, hiddenEndpoint);
    try {
      const unavailable = await diagnose(page, "inspect");
      if (unavailable.status !== "inspected")
        throw Error("Missing offline report");
      expect(unavailable.report.worker.available).toBe(false);
      const offline = join(directory, "offline.json");
      await app.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: path,
        });
      }, offline);
      expect(await diagnose(page, "save")).toMatchObject({
        status: "saved",
        name: "offline.json",
      });
      expect(
        diagnosticsSchema.parse(JSON.parse(await readFile(offline, "utf8")))
          .worker,
      ).toEqual({ available: false, reason: "unreachable" });
    } finally {
      await rename(hiddenEndpoint, endpointPath);
    }
  } finally {
    await app
      .context()
      .tracing.stop({ path: test.info().outputPath("trace.zip") });
  }
});
