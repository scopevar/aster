import { Button, Dropdown } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../components/icons.js";
import { Tooltip } from "../components/tooltip.js";
import "./sidebar-toolbar.css";

export function SidebarToolbar({
  onSearch,
  onNewConversation,
  onNewBot,
  onCreateGroup,
}: {
  onSearch(): void;
  onNewConversation(): void;
  onNewBot(): void;
  onCreateGroup(): void;
}) {
  const addTrigger = useRef<HTMLButtonElement>(null);
  const addMenu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    // Non-modal popovers only close on focus changes; blank areas do not take focus.
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !addTrigger.current?.contains(event.target) &&
        !addMenu.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [open]);
  return (
    <div className="sidebar-top">
      <Button
        variant="ghost"
        className="search sidebar-search"
        aria-label="搜索会话和操作"
        onPress={onSearch}
      >
        <Icon name="search" size={14} />
        <span>搜索</span>
      </Button>
      <Dropdown isOpen={open} onOpenChange={setOpen}>
        <Tooltip content="添加">
          <Dropdown.Trigger
            ref={addTrigger}
            className="sidebar-add"
            aria-label="添加"
            onPointerDownCapture={(event) => {
              if (!open) return;
              // Mouse menu triggers open on press; consume the second press before it can reopen.
              event.stopPropagation();
              setOpen(false);
            }}
          >
            <Icon name="plus" size={16} />
          </Dropdown.Trigger>
        </Tooltip>
        <Dropdown.Popover
          ref={addMenu}
          placement="bottom start"
          className="sidebar-add-menu"
          isNonModal
          shouldCloseOnInteractOutside={(element) =>
            !addTrigger.current?.contains(element)
          }
        >
          <Dropdown.Menu aria-label="添加" aria-labelledby="" autoFocus="first">
            <SidebarAddItem
              id="new"
              label="新建会话"
              icon="mail"
              run={onNewConversation}
            />
            <SidebarAddItem
              id="bot"
              label="新建 Bot"
              icon="plus"
              run={onNewBot}
            />
            <SidebarAddItem
              id="group"
              label="创建群聊"
              icon="group"
              run={onCreateGroup}
            />
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  );
}

function SidebarAddItem({
  id,
  label,
  icon,
  run,
}: {
  id: string;
  label: string;
  icon: IconName;
  run(): void;
}) {
  return (
    <Dropdown.Item id={id} textValue={label} onAction={run}>
      <Icon name={icon} size={15} />
      <span>{label}</span>
    </Dropdown.Item>
  );
}
