import type { ToolExecution } from "../shared/chat/messages.js";
import { actionName, type ComputerTool } from "../shared/tools/tool-calls.js";

/** A quoted/copied tool preserves observed facts, never an inferred success message. */
export function toolText(tool: ToolExecution): string {
  return `命令：${tool.command}\n工作目录：${tool.cwd}\n状态：${tool.status}\n退出码：${tool.exitCode ?? "未返回"}\n输出：\n${tool.output}${tool.truncated ? "\n（输出已截断）" : ""}`;
}

export function computerToolText(tool: ComputerTool): string {
  return `电脑操作：${actionName(tool.action)}\n参数：${JSON.stringify(tool.action)}\n状态：${tool.status}\n结果：${tool.detail}`;
}
