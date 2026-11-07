import { test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("prepare Electron for desktop tests", async () => {
  test.setTimeout(300000);
  const result = await promisify(execFile)(
    process.execPath,
    ["scripts/prepare-electron.mjs"],
    { timeout: 290000, windowsHide: true },
  );
  if (result.stdout) console.log(result.stdout);
});
