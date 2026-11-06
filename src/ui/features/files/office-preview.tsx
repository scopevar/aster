import { IconButton } from "../../components/icon-button.js";
import { Disclosure } from "../../components/disclosure.js";
import { Button } from "@heroui/react";
import { createElement, useState, type ReactNode } from "react";
import type { Attachment } from "../../../shared/files/attachments.js";
import { type OfficeNode } from "../../../shared/files/office.js";
import { desktop, errorMessage } from "../../lib/client.js";
import { Modal } from "../../components/modal.js";
import { Icon } from "../../components/icons.js";
import { TablePreview } from "./table-preview.js";
import "./office-preview.css";
import { useOfficeRead } from "./use-office-read.js";

export function OfficePreview({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose(): void;
}) {
  const { result, error, retry } = useOfficeRead(
    attachment,
    attachment.kind === "docx"
      ? { action: "word.preview" }
      : { action: "table.info" },
  );
  const [saving, setSaving] = useState(false),
    [actionError, setActionError] = useState("");
  const save = async () => {
    setSaving(true);
    setActionError("");
    try {
      await desktop.saveAttachment({
        id: attachment.id,
        conversationId: attachment.conversationId,
      });
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const renderNodes = (nodes: OfficeNode[]): ReactNode =>
    nodes.map((node, index) => {
      if (node.kind === "text") return node.text;
      if (node.kind === "image") {
        const image =
          result?.action === "word.preview"
            ? result.images.find((image) => image.index === node.index)
            : undefined;
        return image?.data ? (
          <img
            key={index}
            src={`data:image/png;base64,${image.data}`}
            alt={node.alt || `文档图片 ${node.index + 1}`}
          />
        ) : (
          <span key={index} className="office-image-error">
            {image?.error ?? "图片不可用"}
          </span>
        );
      }
      if (node.kind === "link") {
        const href = node.href;
        return href ? (
          <a
            key={index}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              void desktop
                .openDocumentLink(href)
                .catch((error) => setActionError(errorMessage(error)));
            }}
          >
            {renderNodes(node.children)}
          </a>
        ) : (
          <span key={index}>{renderNodes(node.children)}</span>
        );
      }
      return createElement(
        node.tag,
        {
          key: index,
          ...(node.colspan ? { colSpan: node.colspan } : {}),
          ...(node.rowspan ? { rowSpan: node.rowspan } : {}),
          ...(node.start === undefined ? {} : { start: node.start }),
        },
        node.tag === "br" || node.tag === "hr"
          ? undefined
          : renderNodes(node.children),
      );
    });
  return (
    <Modal
      title={attachment.name}
      onClose={onClose}
      variant="office"
      actions={
        <>
          <IconButton
            variant="ghost"
            size="sm"
            className="icon-button"
            aria-label="保存原文件"
            isPending={saving}
            onClick={() => void save()}
          >
            <Icon name="download" />
          </IconButton>
        </>
      }
    >
      {actionError && (
        <p className="office-error" role="alert">
          {actionError}
        </p>
      )}
      {error ? (
        <div className="office-notice" role="alert">
          <p>{error}</p>
          <Button variant="ghost" size="sm" onClick={retry}>
            重试读取
          </Button>
        </div>
      ) : !result ? (
        <p className="office-notice" role="status">
          正在读取文档…
        </p>
      ) : (
        <>
          {result.warnings.length > 0 && (
            <Disclosure
              className="office-warnings"
              title={<>文档读取说明（{result.warnings.length}）</>}
            >
              {result.warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </Disclosure>
          )}
          {result.action === "word.preview" && (
            <div className="word-scroll">
              <article className="word-document" aria-label="Word 文档内容">
                {renderNodes(result.nodes)}
              </article>
            </div>
          )}
          {result.action === "table.info" && (
            <TablePreview attachment={attachment} sheets={result.sheets} />
          )}
        </>
      )}
    </Modal>
  );
}
