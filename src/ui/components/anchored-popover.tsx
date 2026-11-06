import "./anchored-popover.css";
import { Popover } from "@heroui/react";
import {
  useMemo,
  useRef,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
} from "react";

export function AnchoredPopover({
  anchor,
  point,
  label,
  className,
  children,
  onClose,
  panelRef,
  onKeyDown,
}: {
  anchor: HTMLElement;
  point?: { x: number; y: number } | undefined;
  label: string;
  className: string;
  children: ReactNode;
  onClose(): void;
  panelRef?: Ref<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}) {
  const trigger = useMemo(() => ({ current: anchor }), [anchor]);
  const pointer = useRef<HTMLSpanElement>(null);
  return (
    <Popover
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {point && (
        <span
          ref={pointer}
          aria-hidden
          style={{
            position: "fixed",
            left: point.x,
            top: point.y,
            width: 1,
            height: 1,
            pointerEvents: "none",
          }}
        />
      )}
      <Popover.Content
        triggerRef={point ? pointer : trigger}
        placement="bottom start"
        offset={6}
        containerPadding={8}
        className="app-anchored-popover"
      >
        <Popover.Dialog
          ref={panelRef}
          aria-label={label}
          className={className}
          {...(onKeyDown ? { onKeyDown } : {})}
        >
          {children}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
