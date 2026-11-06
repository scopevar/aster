import { useState } from "react";
import { errorMessage } from "./client.js";

/** An unreadable pending receipt must survive until the user preserves it. */
export function useDraftRecovery(
  key: string,
  initialError: string,
  setError: (message: string) => void,
) {
  const [blocked, setBlocked] = useState(Boolean(initialError));
  const recover = () => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        localStorage.setItem(`${key}:unreadable:${crypto.randomUUID()}`, raw);
        if (localStorage.getItem(key) !== raw)
          throw Error("原记录已变化，请重新打开后核实。");
        localStorage.removeItem(key);
      }
      setBlocked(false);
      setError("");
    } catch (error) {
      setError(`原记录未能完成备份，已保留：${errorMessage(error)}`);
    }
  };
  return { blocked, recover };
}
