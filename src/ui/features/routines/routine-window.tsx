import { useEffect, useRef } from "react";
import { desktop, errorMessage } from "../../lib/client.js";
import { Icon } from "../../components/icons.js";
import { RoutineEditorPanel } from "./routine-editor-panel.js";
import "./routines.css";
import "../../styles/theme.css";
import { useRoutineEditor } from "./use-routine-editor.js";

function RoutineWindowControls() {
  return (
    <div className="window-controls routine-window-controls">
      {(["minimize", "maximize", "close"] as const).map((action, index) => (
        <button
          key={action}
          aria-label={["最小化", "最大化", "关闭窗口"][index]}
          aria-describedby={`routine-window-${action}-tooltip`}
          onClick={() => {
            void desktop
              .routineWindowAction(action)
              .catch((cause) => console.error(errorMessage(cause)));
          }}
        >
          <Icon
            name={
              action === "minimize"
                ? "minus"
                : action === "maximize"
                  ? "square"
                  : "close"
            }
            size={12}
          />
          <span
            id={`routine-window-${action}-tooltip`}
            className="window-control-tooltip"
            role="tooltip"
          >
            {["最小化", "最大化", "关闭"][index]}
          </span>
        </button>
      ))}
    </div>
  );
}

export function RoutineWindow({
  botId,
  routineId,
}: {
  botId: string;
  routineId?: string | undefined;
}) {
  const onClose = () => {
    void desktop
      .routineWindowAction("close")
      .catch((cause) => console.error(errorMessage(cause)));
  };
  const model = useRoutineEditor({
    botId,
    initialRoutineId: routineId,
    onClose,
    onConversation: (id) => {
      void desktop
        .focusConversation(id)
        .catch((cause) => console.error(errorMessage(cause)));
    },
  });
  const active = useRef(model.pending !== null || model.busy);
  active.current = model.pending !== null || model.busy;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (active.current) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("dialog, input, textarea, select, [role=dialog]")
      )
        return;
      closeRef.current();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  return (
    <div className="routine-window">
      <header className="routine-window-titlebar">
        <Icon name="clock" size={16} />
        <strong>例行任务</strong>
        <span className="drag-region" />
        <RoutineWindowControls />
      </header>
      <main className="routine-window-content">
        <RoutineEditorPanel {...model} />
      </main>
    </div>
  );
}
