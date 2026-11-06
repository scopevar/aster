import "./styles/theme.css";
import "./styles/styles.css";
import "./features/routines/routine-startup.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppTheme } from "./app/app-theme.js";
import { AppToaster } from "./components/toast.js";
import { RoutineWindow } from "./features/routines/routine-window.js";

const root = document.getElementById("root");
if (!root) throw new Error("Routine root missing");
const parameters = new URLSearchParams(location.search);
const botId = parameters.get("botId");
if (!botId) throw new Error("Routine Bot missing");
createRoot(root).render(
  <StrictMode>
    <AppTheme>
      <RoutineWindow
        botId={botId}
        routineId={parameters.get("routineId") ?? undefined}
      />
      <AppToaster />
    </AppTheme>
  </StrictMode>,
);
