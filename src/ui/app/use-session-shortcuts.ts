import { useEffect } from "react";
import type { AppModal } from "./app-state.js";
import type { StateSetter } from "../lib/react-state.js";
export function useSessionShortcuts(setModal: StateSetter<AppModal>) {
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "a" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target instanceof HTMLElement && event.target.isContentEditable)
      ) {
        event.preventDefault();
      }
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (document.querySelector('[role="dialog"][aria-modal="true"]'))
          return;
        setModal((previous) => (previous ? previous : "search"));
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
    };
  }, []);
}
