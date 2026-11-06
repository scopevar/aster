/** Closing a window keeps Main alive; quitting the controller leaves the independent daemon running. */
export function workerActionForDesktop(
  event: "window-closed" | "quit-ui" | "worker-stop",
): "leave-running" | "stop" {
  return event === "worker-stop" ? "stop" : "leave-running";
}
