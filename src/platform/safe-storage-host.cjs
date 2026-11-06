const { app, safeStorage } = require("electron");
const { readFileSync, writeFileSync } = require("fs");

const directory = process.env.ASTER_SAFE_STORAGE_DIR;
const mode = process.env.ASTER_SAFE_STORAGE_MODE;
const inputPath = process.env.ASTER_SAFE_STORAGE_IN;
const outputPath = process.env.ASTER_SAFE_STORAGE_OUT;
if (
  !directory ||
  (mode !== "seal" && mode !== "open") ||
  !inputPath ||
  !outputPath
) {
  process.stderr.write("凭据保护参数无效。\n");
  process.exit(1);
}
if (process.env.ASTER_SAFE_STORAGE_PLAIN === "1")
  safeStorage.setUsePlainTextEncryption(true);
app.setName("aster");
app.setPath("userData", directory);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

app.whenReady().then(() => {
  try {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.env.ASTER_STRICT_SECRETS === "1" &&
        process.platform === "linux" &&
        safeStorage.getSelectedStorageBackend() === "basic_text")
    ) {
      process.stderr.write("encryption unavailable\n");
      app.exit(3);
      return;
    }
    const input = readFileSync(inputPath);
    const output =
      mode === "seal"
        ? safeStorage.encryptString(input.toString("utf8"))
        : Buffer.from(safeStorage.decryptString(input), "utf8");
    writeFileSync(outputPath, output);
    // Flush Chromium's OS crypt preferences before another standalone helper
    // opens this key; app.exit() can discard a newly generated wrapping key.
    app.quit();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "凭据保护失败"}\n`,
    );
    app.exit(1);
  }
});
