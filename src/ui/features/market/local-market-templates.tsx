import { Button } from "@heroui/react";
import { useEffect, useState } from "react";
import {
  templatesResponseSchema,
  type LocalTemplates,
} from "../../../shared/templates/templates.js";
import { Icon } from "../../components/icons.js";
import { desktop, errorMessage } from "../../lib/client.js";
import { LocalMarketEmpty } from "./local-market-empty.js";

export function LocalMarketTemplates({
  query,
  revision,
  onEdit,
}: {
  query: string;
  revision: number;
  onEdit(id: string): void;
}) {
  const [view, setView] = useState<LocalTemplates | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    // Keep the initiating button mounted while the nested editor restores focus.
    void desktop
      .templates({ kind: "local" })
      .then((value) => {
        const response = templatesResponseSchema.parse(value);
        if (response.kind !== "local")
          throw new Error("本地模板列表响应无效。");
        if (active) setView(response.data);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [revision, retry]);
  if (error)
    return (
      <div className="local-market-empty">
        <p role="alert">{error}</p>
        <Button
          variant="secondary"
          size="sm"
          onPress={() => setRetry(retry + 1)}
        >
          重新读取模板
        </Button>
      </div>
    );
  if (!view) return <LocalMarketEmpty icon="hourglass" title="正在读取模板…" />;
  const search = query.trim().toLocaleLowerCase();
  const matches = view.drafts.filter((draft) =>
    [draft.name, draft.description].some((text) =>
      text.toLocaleLowerCase().includes(search),
    ),
  );
  if (!matches.length)
    return (
      <LocalMarketEmpty
        icon="book"
        title={search ? "没有匹配的模板" : "还没有本地模板"}
      >
        {!search && <p>导入模板文件，或在 Bot 聊天的模板操作中创建。</p>}
      </LocalMarketEmpty>
    );
  return (
    <div className="local-market-grid">
      {matches.map((draft) => (
        <article
          className="local-market-card"
          aria-label={draft.name}
          key={draft.id}
        >
          <span className="local-market-template-icon">
            <Icon name="book" size={26} />
          </span>
          <h3>{draft.name}</h3>
          <p>{draft.description || "编辑配置，选择内容后导出为模板文件。"}</p>
          <Button
            variant="secondary"
            size="sm"
            aria-label={"编辑模板 " + draft.name}
            onPress={() => onEdit(draft.id)}
          >
            编辑与导出 <Icon name="chevron" size={14} />
          </Button>
        </article>
      ))}
    </div>
  );
}
