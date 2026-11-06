import { RoutineEditorView } from "./routine-editor-view.js";
import "./routines.css";
import { useRoutineEditor } from "./use-routine-editor.js";

export function RoutineManager({
  botId,
  onClose,
  onConversation,
  initialRoutineId,
  remote,
}: {
  botId: string;
  remote?: Parameters<typeof useRoutineEditor>[0]["remote"];
  initialRoutineId?: string | undefined;
  onClose(): void;
  onConversation(id: string): void;
}) {
  const model = useRoutineEditor({
    botId,
    onClose,
    onConversation,
    initialRoutineId,
    remote,
  });
  return <RoutineEditorView {...model} />;
}
