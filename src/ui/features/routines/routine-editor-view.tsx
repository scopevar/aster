import { Modal } from "../../components/modal.js";
import { useEffect, useId } from "react";
import { RoutineEditorPanel } from "./routine-editor-panel.js";
import "./routines.css";
import type { RoutineEditorViewModel } from "./use-routine-editor.js";

export function RoutineEditorView(model: RoutineEditorViewModel) {
  const dialogId = useId();
  useEffect(() => {
    if (!model.busy && document.activeElement === document.body)
      document.getElementById(dialogId)?.focus({ preventScroll: true });
  }, [model.busy, dialogId]);
  return (
    <Modal
      title="例行任务"
      onClose={model.onClose}
      id={dialogId}
      className="routine-dialog"
    >
      <Modal.Body>
        <RoutineEditorPanel {...model} />
      </Modal.Body>
    </Modal>
  );
}
