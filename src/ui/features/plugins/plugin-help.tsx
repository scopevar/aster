import { IconButton } from "../../components/icon-button.js";
import { Popover } from "@heroui/react";
import { Icon } from "../../components/icons.js";
import "./plugin-help.css";

export function PluginHelp() {
  return (
    <Popover>
      <IconButton
        variant="ghost"
        size="sm"
        className="plugin-help-trigger"
        aria-label="插件使用说明"
      >
        <Icon name="info" size={16} />
      </IconButton>
      <Popover.Content
        placement="bottom start"
        className="plugin-help-popover"
        offset={8}
      >
        <Popover.Dialog aria-label="插件使用说明">
          <Popover.Heading>插件使用说明</Popover.Heading>
          <p>
            可导入 Cursor 或 Claude Code 插件目录，包含技能、命令、规则及 MCP
            服务。
          </p>
          <p>
            支持 HTTP、SSE 和 stdio 连接。本机 stdio
            程序可访问当前系统，只启用你信任的插件。
          </p>
          <p>远程服务可在安装后连接账号，在浏览器中完成授权。</p>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
