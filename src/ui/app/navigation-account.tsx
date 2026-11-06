import { IconButton } from "../components/icon-button.js";
import { Dropdown } from "@heroui/react";
import { Icon } from "../components/icons.js";
import "./navigation-account.css";
import "./app-menu.css";

export function NavigationAccount({
  showHidden,
  onSettings,
  onHidden,
  onCheck,
}: {
  showHidden: boolean;
  onSettings(tab: "通用"): void;
  onHidden(): void;
  onCheck(): void;
}) {
  return (
    <div className="navigation-account">
      <Dropdown>
        <IconButton
          variant="ghost"
          className="navigation-rail-item"
          aria-label="应用菜单：本地工作区"
        >
          <Icon name="settings" size={22} />
        </IconButton>
        <Dropdown.Popover placement="top start" className="account-menu">
          <Dropdown.Menu aria-label="应用" aria-labelledby="" autoFocus="first">
            <Dropdown.Item
              id="settings"
              textValue="设置"
              onAction={() => onSettings("通用")}
            >
              <Icon name="settings" size={20} />
              <span>设置</span>
            </Dropdown.Item>
            <Dropdown.Item
              id="hidden"
              textValue="显示隐藏 Bot"
              onAction={onHidden}
            >
              <Icon name="hide" size={20} />
              <span>{showHidden ? "仅显示可见 Bot" : "显示隐藏 Bot"}</span>
            </Dropdown.Item>
            <Dropdown.Item
              id="check"
              textValue="检查 Agent 连接"
              onAction={onCheck}
            >
              <Icon name="computer" size={20} />
              <span>检查 Agent 连接</span>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  );
}
