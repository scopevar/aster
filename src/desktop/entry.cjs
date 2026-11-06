// The installed executable always loads this file and ignores any extra script
// path. Credential protection has to finish before the desktop singleton lock.
const mode = process.env.ASTER_SAFE_STORAGE_MODE;
if (mode === "seal" || mode === "open") require("./safe-storage-host.cjs");
else require("./main.cjs");
