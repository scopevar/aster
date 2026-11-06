import { WindowControls } from "./window-controls.js";
import "./app-titlebar.css";

export function AppTitlebar(props: Parameters<typeof WindowControls>[0]) {
  return (
    <header className="app-titlebar" aria-label="应用标题栏">
      <div className="app-titlebar-brand">
        <img src="./assets/aster-avatar.png" alt="" draggable={false} />
        <span>Aster</span>
      </div>
      <div className="drag-region" />
      <WindowControls {...props} />
    </header>
  );
}
