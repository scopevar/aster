import type { DesktopEnvelope as Envelope } from "../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../shared/desktop/desktop-commands.js";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import { envelope, errorMessage, execute } from "./client.js";
import { CommandQueue } from "./command-queue.js";
export function useCommandQueue(
  refresh: () => Promise<void>,
  setError: Dispatch<SetStateAction<string>>,
) {
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const callbacks = useRef({ refresh, setError });
  callbacks.current = { refresh, setError };
  const queue = useRef<CommandQueue | null>(null);
  queue.current ??= new CommandQueue(async (command, request) => {
    const result = await execute(request ?? envelope(command));
    // SSE updates persisted drafts; sending each keystroke never needs a full snapshot.
    callbacks.current.setError("");
    if (command.type !== "draft.save") {
      try {
        await callbacks.current.refresh();
      } catch (error) {
        callbacks.current.setError(
          `操作已提交，界面刷新失败：${errorMessage(error)}`,
        );
      }
    }
    return result;
  });
  useEffect(() => {
    const flush = () => queue.current?.flush();
    window.addEventListener("beforeunload", flush);
    window.addEventListener("blur", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("blur", flush);
      flush();
    };
  }, []);
  const submit = useCallback((command: Command, request?: Envelope) => {
    const task = queue.current!.submit(command, request);
    chain.current = task;
    return task;
  }, []);
  const act = useCallback(
    (command: Command, request?: Envelope) =>
      submit(command, request).catch((e) => {
        setError(errorMessage(e));
        return undefined;
      }),
    [submit, setError],
  );
  return { submit, act, chain };
}

export type CommandQueueViewModel = ReturnType<typeof useCommandQueue>;
