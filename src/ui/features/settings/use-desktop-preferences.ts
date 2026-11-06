import { useEffect, useRef, useState } from "react";
import {
  desktopPreferencesSchema,
  type DesktopPreferences,
  type PreferencesChange,
} from "../../../shared/desktop/preferences.js";
import { desktop, errorMessage } from "../../lib/client.js";
export function useDesktopPreferences(setError: (error: string) => void) {
  const [preferences, setPreferences] = useState<DesktopPreferences | null>(
    null,
  );
  const latest = useRef<DesktopPreferences | null>(null);
  const writes = useRef(Promise.resolve());
  const publish = (value: DesktopPreferences) => {
    latest.current = value;
    setPreferences(value);
  };
  useEffect(() => {
    let disposed = false;
    void desktop
      .preferences()
      .then((value) => {
        if (!disposed) publish(desktopPreferencesSchema.parse(value));
      })
      .catch((e) => {
        if (!disposed) setError(errorMessage(e));
      });
    return () => {
      disposed = true;
    };
  }, []);
  const saveDesktopPreferences = (change: PreferencesChange) => {
    // Only rebase changes queued against the current UI revision; stale drafts stay stale.
    const currentAtSubmission = change.revision === latest.current?.revision;
    const task = writes.current.then(async () => {
      try {
        publish(
          desktopPreferencesSchema.parse(
            await desktop.savePreferences({
              ...change,
              revision: currentAtSubmission
                ? (latest.current?.revision ?? change.revision)
                : change.revision,
            }),
          ),
        );
      } catch (saveError) {
        // Reconcile an unknown write before a queued change or an explicit retry.
        try {
          publish(desktopPreferencesSchema.parse(await desktop.preferences()));
        } catch (readError) {
          throw new Error(
            `${errorMessage(saveError)} 重新读取设置失败：${errorMessage(readError)}`,
          );
        }
        throw saveError;
      }
    });
    // Keep the queue usable after a failure; the caller still receives the rejected task.
    writes.current = task.catch(() => {});
    return task;
  };
  return { preferences, setPreferences, saveDesktopPreferences };
}

export type DesktopPreferencesViewModel = ReturnType<
  typeof useDesktopPreferences
>;
