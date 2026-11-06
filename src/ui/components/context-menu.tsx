import { Dropdown, Separator } from "@heroui/react";
import { Fragment, useRef, useState } from "react";
import { errorMessage } from "../lib/client.js";
import { Icon, type IconName } from "./icons.js";

export interface MenuAction {
  label: string;
  icon: IconName;
  run?(): Promise<void> | void;
  children?: MenuAction[];
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  destructive?: boolean;
}

export function ContextMenu({
  anchor,
  point,
  actions,
  onClose,
}: {
  anchor: HTMLElement;
  point?: { x: number; y: number } | undefined;
  actions: MenuAction[];
  onClose(): void;
}) {
  const [open, setOpen] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const closed = useRef(false);
  const bounds = anchor.getBoundingClientRect();
  const position = point ?? { x: bounds.right, y: bounds.top };
  const finish = () => {
    if (closed.current) return;
    closed.current = true;
    setOpen(false);
    if (anchor.isConnected) anchor.focus({ preventScroll: true });
    onClose();
  };
  const run = async (action: MenuAction | undefined) => {
    if (!action || action.children || pending || action.disabled) return;
    setPending(true);
    setError("");
    try {
      await action.run?.();
      finish();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  const item = (action: MenuAction, key: string, nested = false) => (
    <Dropdown.Item
      key={key}
      id={key}
      textValue={action.label}
      isDisabled={pending || !!action.disabled}
      {...(action.destructive ? { className: "destructive" } : {})}
      onAction={() => {
        void run(action);
      }}
    >
      {nested ? (
        <span className="menu-check" aria-hidden="true">
          <Icon name={action.checked ? "check" : action.icon} size={15} />
        </span>
      ) : (
        <Icon name={action.icon} size={15} />
      )}
      {action.label}
    </Dropdown.Item>
  );
  return (
    <Dropdown
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) finish();
      }}
    >
      <Dropdown.Trigger
        className="context-menu-anchor"
        aria-label="Bot 操作"
        style={{ left: position.x, top: position.y }}
      />
      <Dropdown.Popover placement="bottom start" className="context-menu">
        <Dropdown.Menu
          aria-label="Bot 操作"
          aria-labelledby=""
          autoFocus="first"
          shouldCloseOnSelect={false}
        >
          {actions.map((action, index) => (
            <Fragment key={index}>
              {action.separator && <Separator />}
              {action.children ? (
                <Dropdown.SubmenuTrigger>
                  <Dropdown.Item
                    id={String(index)}
                    textValue={action.label}
                    isDisabled={pending || !!action.disabled}
                  >
                    <Icon name={action.icon} size={15} />
                    {action.label}
                    <Dropdown.SubmenuIndicator>
                      <Icon name="chevron" size={14} />
                    </Dropdown.SubmenuIndicator>
                  </Dropdown.Item>
                  <Dropdown.Popover className="context-submenu">
                    <Dropdown.Menu
                      aria-label={action.label}
                      aria-labelledby=""
                      shouldCloseOnSelect={false}
                      onAction={(key) => {
                        const child = action.children?.[Number(key)];
                        void run(child);
                      }}
                    >
                      {action.children.map((child, childIndex) => (
                        <Fragment key={childIndex}>
                          {child.separator && <Separator />}
                          {item(child, `${index}-${childIndex}`, true)}
                        </Fragment>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown.SubmenuTrigger>
              ) : (
                item(action, String(index))
              )}
            </Fragment>
          ))}
          {error && (
            <Dropdown.Item
              id="error"
              textValue={error}
              isDisabled
              className="context-menu-error"
            >
              <div role="alert">{error}</div>
            </Dropdown.Item>
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
