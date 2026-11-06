import type { PluginCall } from "../shared/tools/plugins.js";
/** Preserve observed status in copied, quoted and archived plugin receipts. */
export function pluginCallText(call: PluginCall): string {
  return `插件工具：${call.pluginName} / ${call.server} / ${call.tool}\n参数：${JSON.stringify(call.arguments)}\n状态：${call.status}\n记录：${call.detail}`;
}
