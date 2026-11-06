import { Disclosure } from "../../components/disclosure.js";
import type { ToolExecution } from "../../../shared/chat/messages.js";
import { Icon } from "../../components/icons.js";

const statusNames: Record<ToolExecution["status"], string> = {
  running: "执行中",
  completed: "已完成",
  failed: "执行失败",
  declined: "已拒绝",
  unknown: "结果未知",
};
export function ToolCard({ tool }: { tool: ToolExecution }) {
  return (
    <Disclosure
      className={`tool-card ${tool.status}`}
      title={
        <>
          <Icon name="computer" size={16} />
          <strong>执行命令</strong>
          <span role="status">{statusNames[tool.status]}</span>
        </>
      }
    >
      <div className="tool-content">
        <dl>
          <dt>命令</dt>
          <dd>
            <code>{tool.command}</code>
          </dd>
          <dt>工作目录</dt>
          <dd>{tool.cwd}</dd>
          {tool.exitCode !== null && (
            <>
              <dt>退出码</dt>
              <dd>{tool.exitCode}</dd>
            </>
          )}
          {tool.durationMs !== null && (
            <>
              <dt>耗时</dt>
              <dd>{(tool.durationMs / 1000).toFixed(2)} 秒</dd>
            </>
          )}
        </dl>
        {tool.output && <pre aria-label="命令输出">{tool.output}</pre>}
        {tool.truncated && (
          <p className="muted small-text">
            输出超过展示上限，部分内容已截断（最多 65,536 个字符）。
          </p>
        )}
        {tool.status === "unknown" && (
          <p className="error">
            没有收到工具完成确认，请核实实际结果后再决定是否重试。
          </p>
        )}
      </div>
    </Disclosure>
  );
}
