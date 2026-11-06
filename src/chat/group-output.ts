import type { AgentEvent } from "./agent.js";

const pass = "[[ASTER_PASS]]";
/** Hold only a possible pass marker; stream ordinary text as soon as it differs. */
export function groupOutput(emit: (event: AgentEvent) => void) {
  const pending = new Map<string, string>();
  const visible = new Set<string>();
  let contributed = false;
  return {
    get contributed() {
      return contributed;
    },
    accept(event: AgentEvent) {
      if (event.type !== "text") {
        if (event.type === "tool" || event.type === "file") contributed = true;
        emit(event);
        return;
      }
      if (visible.has(event.itemId)) {
        emit(event);
        return;
      }
      const text = event.complete
        ? event.text
        : (pending.get(event.itemId) ?? "") + event.text;
      if (event.complete) {
        pending.delete(event.itemId);
        if (!text.trim() || text.trim() === pass) return;
      } else if (text.length < 128 && pass.startsWith(text.trim())) {
        pending.set(event.itemId, text);
        return;
      }
      pending.delete(event.itemId);
      visible.add(event.itemId);
      contributed = true;
      emit({ ...event, text });
    },
  };
}
