import type { PluginCall } from "../shared/tools/plugins.js";
import { pluginCallText } from "./plugin-text.js";
import type { Attachment } from "../shared/files/attachments.js";
import type { ToolExecution } from "../shared/chat/messages.js";
import { questionText, type Question } from "../shared/chat/questions.js";
import type { ComputerTool } from "../shared/tools/tool-calls.js";
import { computerToolText, toolText } from "./tool-text.js";
export function quoteText(input: {
  text: string;
  tool: ToolExecution | null;
  computerTool: ComputerTool | null;
  pluginCall?: PluginCall | null;
  question: Question | null;
  attachments: Attachment[];
}) {
  const content = input.question
    ? questionText(input.question)
    : input.pluginCall
      ? pluginCallText(input.pluginCall)
      : input.computerTool
        ? computerToolText(input.computerTool)
        : input.tool
          ? toolText(input.tool)
          : input.text;
  return input.attachments.length
    ? `${content}${content ? "\n" : ""}附件：${input.attachments.map((file) => file.name).join("、")}`
    : content;
}
