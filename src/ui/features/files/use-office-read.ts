import { useEffect, useRef, useState } from "react";
import type { Attachment } from "../../../shared/files/attachments.js";
import {
  officeOperationSchema,
  officeResultSchema,
  type OfficeOperation,
  type OfficeResult,
} from "../../../shared/files/office.js";
import { desktop, errorMessage } from "../../lib/client.js";

/** Serializes a view's requests so rapid scrolling cannot outlive or overwrite its current selection. */
export function useOfficeRead(
  attachment: Attachment,
  operation: OfficeOperation,
  enabled = true,
) {
  const [result, setResult] = useState<OfficeResult | null>(null),
    [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const serialized = JSON.stringify(operation);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false,
      sent = false;
    const requestId = crypto.randomUUID();
    setResult(null);
    setError("");
    const task = pending.current
      .then(async () => {
        if (disposed) return;
        sent = true;
        const value = await desktop.documentPreview({
          requestId,
          id: attachment.id,
          conversationId: attachment.conversationId,
          operation: officeOperationSchema.parse(JSON.parse(serialized)),
        });
        if (!disposed) setResult(officeResultSchema.parse(value));
      })
      .catch((error) => {
        if (!disposed) setError(errorMessage(error));
      });
    pending.current = task;
    return () => {
      disposed = true;
      if (sent)
        void desktop
          .cancelDocumentPreview(requestId)
          .catch((error) =>
            console.error(
              "Document preview cancellation failed",
              requestId,
              errorMessage(error),
            ),
          );
    };
  }, [attachment.id, attachment.conversationId, serialized, attempt, enabled]);
  return { result, error, retry: () => setAttempt((value) => value + 1) };
}
