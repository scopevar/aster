import type { RefObject } from "react";
import { desktop, errorMessage } from "../../lib/client.js";
import { Icon } from "../icons.js";

export function WindowControls({
  chain,
  onError,
}: {
  chain: RefObject<Promise<unknown>>;
  onError(message: string): void;
}) {
  return (
    <div className="window-controls">
      {(["minimize", "maximize", "close"] as const).map((action, index) => (
        <button
          key={action}
          aria-label={["最小化", "最大化", "关闭窗口"][index]}
          aria-describedby={`window-${action}-tooltip`}
          onClick={() => {
            void chain.current
              .finally(() => desktop.windowAction(action))
              .catch((cause) => onError(errorMessage(cause)));
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
            strokeWidth={1.5}
          />
          <span
            id={`window-${action}-tooltip`}
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
