// Establish the cascade before a component stylesheet can create a layer.
import "./styles/theme.css";
import "./styles/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppView } from "./app/app-view.js";
import "./features/memory/memory.css";
import "./features/skills/skills.css";
import { AppToaster } from "./components/toast.js";
import { AppTheme } from "./app/app-theme.js";
import { LocalWorkspaceGate } from "./app/local-workspace.js";
import { useAppSession } from "./app/use-app-session.js";
function App() {
  const model = useAppSession();
  return <AppView {...model} />;
}
const root = document.getElementById("root");
if (!root) throw new Error("App root missing");
createRoot(root).render(
  <StrictMode>
    <AppTheme>
      <LocalWorkspaceGate>
        <App />
      </LocalWorkspaceGate>
      <AppToaster />
    </AppTheme>
  </StrictMode>,
);
