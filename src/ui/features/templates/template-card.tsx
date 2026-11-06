import { Button } from "@heroui/react";
import type { TemplateReceipt } from "../../../shared/templates/template-tools.js";
import { Avatar, Icon } from "../../components/icons.js";
import "./template-card.css";
export function TemplateCard({
  receipt,
  onOpen,
}: {
  receipt: TemplateReceipt;
  onOpen(id: string): void;
}) {
  return (
    <section className="template-message-card" aria-label="模板草稿卡">
      <header>
        {receipt.image ? (
          <img
            className="template-cover"
            src={`data:image/webp;base64,${receipt.image}`}
            alt="模板头像"
          />
        ) : (
          <Avatar
            appearance={{
              shape: receipt.appearance?.shape ?? "blob",
              color: receipt.appearance?.color ?? "gray",
              imageHash: null,
              revision: 0,
            }}
          />
        )}
        <div>
          <h3>{receipt.name}</h3>
          <span>本地模板草稿</span>
        </div>
      </header>
      <p>{receipt.description}</p>
      <footer>
        <small>修订 {receipt.revision}</small>
        <Button
          variant="secondary"
          size="sm"
          onPress={() => onOpen(receipt.id)}
        >
          管理本地模板
          <Icon name="chevron" size={14} />
        </Button>
      </footer>
    </section>
  );
}
