import { AppTitlebar } from "../components/window/app-titlebar.js";
import "./app-startup.css";

export function AppStartup(props: Parameters<typeof AppTitlebar>[0]) {
  return (
    <div className="app">
      <AppTitlebar {...props} />
      <main className="app-startup" role="status" aria-label="正在启动 Aster">
        <img src="./assets/aster-avatar.png" alt="" draggable={false} />
        <strong>Aster</strong>
        <span>正在启动…</span>
      </main>
    </div>
  );
}
