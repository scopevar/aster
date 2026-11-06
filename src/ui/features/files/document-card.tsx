import { Disclosure } from "../../components/disclosure.js";
import type { DocumentCall } from "../../../shared/files/documents.js";
import { Icon } from "../../components/icons.js";
const labels = {
  running: "读取中",
  completed: "已完成",
  failed: "读取失败",
  cancelled: "已取消",
};
export function DocumentCard({ call }: { call: DocumentCall }) {
  return (
    <Disclosure
      key={call.status}
      className={`tool-card document-card ${call.status}`}
      defaultExpanded={call.status === "failed"}
      title={
        <>
          <Icon name="file" size={20} />
          <strong>
            {call.action === "list"
              ? "查找文档附件"
              : call.action === "render"
                ? "查看 PDF 页面"
                : call.action.startsWith("table.")
                  ? "读取表格"
                  : call.action.startsWith("word.")
                    ? "读取 Word 文档"
                    : call.action.startsWith("video.")
                      ? "读取视频画面"
                      : "读取 PDF"}
          </strong>
          <span role="status">{labels[call.status]}</span>
        </>
      }
    >
      <div className="tool-content">
        <p>{call.name}</p>
        <p role={call.status === "failed" ? "alert" : undefined}>
          {call.detail}
        </p>
      </div>
    </Disclosure>
  );
}
