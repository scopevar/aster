import { app } from "electron";
// An isolated second OS process; tests register keys through Electron's real API.
app.setPath("userData", process.env.ASTER_DATA_DIR);
app.whenReady().catch(() => app.exit(1));
