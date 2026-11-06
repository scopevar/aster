import fs from "node:fs";
import { basename } from "node:path";
import { syncBuiltinESMExports } from "node:module";

// Test-process-only fault injection. Production has no crash flags or alternate paths.
const [directory, phase] = process.argv.slice(2);
if (!directory || !phase)
  throw Error("Missing restore crash fixture arguments");
const rename = fs.renameSync;
const remove = fs.rmSync;
const write = fs.writeFileSync;
let journals = 0;
const crash = (boundary) => {
  if (phase === boundary) process.exit(73);
};
if (phase === "journal-write-failure")
  fs.writeFileSync = (file, data, ...options) => {
    if (
      typeof file === "number" &&
      typeof data === "string" &&
      data.includes('"phase":"prepared"')
    ) {
      write(file, "{partial");
      throw Object.assign(new Error("Injected journal disk-full failure"), {
        code: "ENOSPC",
      });
    }
    return write(file, data, ...options);
  };
fs.renameSync = (source, destination) => {
  rename(source, destination);
  const from = basename(String(source)),
    to = basename(String(destination));
  if (to === "restore-transaction.json")
    crash(++journals === 1 ? "prepared" : "committed");
  if (to.startsWith(".restore-displaced-")) crash("displaced");
  if (to === "aster.sqlite" && from.startsWith(".restore-next-"))
    crash("installed-before-commit");
  if (to.startsWith(".restore-prior-")) crash("previous-held");
  if (to === "aster.sqlite.previous" && from.startsWith(".restore-displaced-"))
    crash("previous-promoted");
  if (to === "restore-result.json") crash("result-recorded");
};
fs.rmSync = (path, options) => {
  remove(path, options);
  const name = basename(String(path));
  if (name === "pending-restore.json") crash("request-removed");
  if (name.startsWith(".restore-prior-")) crash("prior-removed");
  if (name === "restore-transaction.json") crash("journal-removed");
};
syncBuiltinESMExports();
const { applyPendingRestore } =
  await import("../../src/storage/backup/backup.ts");
await applyPendingRestore(directory);
if (phase === "journal-write-failure") process.exit(0);
throw Error(`Crash boundary not reached: ${phase}`);
