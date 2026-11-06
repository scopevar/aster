import { Tooltip } from "../../components/tooltip.js";
import { IconButton } from "../../components/icon-button.js";
import { Button } from "@heroui/react";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useRef, useState, useEffect } from "react";
import type {
  Attachment,
  AttachmentContent,
} from "../../../shared/files/attachments.js";
import {
  attachmentContentSchema,
  maxAttachmentBytes,
  maxAttachmentsPerMessage,
} from "../../../shared/files/attachments.js";
import type { CommandResult } from "../../../shared/core.js";
import { desktop, errorMessage } from "../../lib/client.js";
import { Icon } from "../../components/icons.js";
import { Modal } from "../../components/modal.js";
import { PdfPreview } from "./pdf-preview.js";
import { OfficePreview } from "./office-preview.js";

interface Upload {
  id: string;
  conversationId: string;
  file: File;
  status: "queued" | "uploading" | "failed";
  error: string;
}
export function useAttachments(
  refresh: () => Promise<void>,
  act: (command: Command) => Promise<CommandResult | undefined>,
) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const cancelled = useRef(new Set<string>());
  const retained = useRef(new Set<string>());
  const queued = useRef(new Set<string>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const enqueue = (upload: Upload) => {
    if (queued.current.has(upload.id)) return;
    queued.current.add(upload.id);
    queue.current = queue.current
      .then(async () => {
        if (cancelled.current.has(upload.id)) return;
        setUploads((old) =>
          old.map((item) =>
            item.id === upload.id
              ? { ...item, status: "uploading", error: "" }
              : item,
          ),
        );
        try {
          if (upload.file.size > maxAttachmentBytes)
            throw new Error("单个附件最多 25 MiB。");
          const bytes = new Uint8Array(await upload.file.arrayBuffer());
          if (cancelled.current.has(upload.id)) return;
          await desktop.uploadAttachment(
            {
              id: upload.id,
              conversationId: upload.conversationId,
              name: upload.file.name,
            },
            bytes,
          );
          await refresh();
          retained.current.delete(upload.id);
          setUploads((old) => old.filter((item) => item.id !== upload.id));
        } catch (error) {
          if (!cancelled.current.has(upload.id))
            setUploads((old) =>
              old.map((item) =>
                item.id === upload.id
                  ? { ...item, status: "failed", error: errorMessage(error) }
                  : item,
              ),
            );
        }
      })
      .finally(() => {
        queued.current.delete(upload.id);
        cancelled.current.delete(upload.id);
      });
  };
  return {
    uploads,
    wait: () => queue.current,
    add(conversationId: string, files: File[]) {
      if (
        files.length > maxAttachmentsPerMessage ||
        retained.current.size + files.length > maxAttachmentsPerMessage
      )
        throw new Error("每批最多添加 8 个文件，请先处理现有上传。");
      const next: Upload[] = files.map((file) => ({
        id: crypto.randomUUID(),
        conversationId,
        file,
        status: "queued",
        error: "",
      }));
      setUploads((old) => [...old, ...next]);
      next.forEach((upload) => retained.current.add(upload.id));
      next.forEach(enqueue);
    },
    retry(upload: Upload) {
      enqueue(upload);
    },
    async remove(id: string, conversationId: string) {
      if (queued.current.has(id)) cancelled.current.add(id);
      try {
        await desktop.cancelUpload(id);
        const result = await act({
          type: "attachment.remove",
          id,
          conversationId,
        });
        if (!result) throw new Error("移除尚未确认，请重试。");
        retained.current.delete(id);
        setUploads((old) => old.filter((item) => item.id !== id));
      } catch (error) {
        setUploads((old) =>
          old.map((item) =>
            item.id === id
              ? { ...item, status: "failed", error: errorMessage(error) }
              : item,
          ),
        );
        throw error;
      }
    },
  };
}
export function AttachmentList({
  attachments,
  onOpen,
  onRemove,
}: {
  attachments: Attachment[];
  onOpen(file: Attachment): void;
  onRemove?: ((file: Attachment) => Promise<void>) | undefined;
}) {
  const [error, setError] = useState("");
  return (
    <div className="attachment-list" aria-label="附件">
      {attachments.map((file) => (
        <div className="attachment-chip" key={file.id}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpen(file)}
            aria-label={`预览 ${file.name}`}
          >
            <Icon name={file.kind === "image" ? "image" : "file"} size={20} />
            <span>
              <strong>{file.name}</strong>
              <small>
                {file.size < 1024
                  ? `${file.size} B`
                  : `${Math.ceil(file.size / 1024)} KiB`}
              </small>
            </span>
          </Button>
          {onRemove && (
            <IconButton
              variant="ghost"
              size="sm"
              className="icon-button"
              aria-label={`移除 ${file.name}`}
              onClick={() => {
                void onRemove(file).catch((e) => setError(errorMessage(e)));
              }}
            >
              <Icon name="close" size={13} />
            </IconButton>
          )}
        </div>
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function UploadList({
  uploads,
  onRetry,
  onCancel,
}: {
  uploads: Upload[];
  onRetry(upload: Upload): void;
  onCancel(upload: Upload): Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <div className="upload-list">
      {uploads.map((file) => (
        <div key={file.id} className={`upload-row ${file.status}`}>
          <Icon name="file" size={20} />
          <span>
            {file.file.name}
            <small role={file.status === "failed" ? "alert" : "status"}>
              {file.status === "queued"
                ? "等待上传"
                : file.status === "uploading"
                  ? "正在上传…"
                  : file.error}
            </small>
          </span>
          {file.status === "failed" && (
            <Button variant="ghost" size="sm" onClick={() => onRetry(file)}>
              重试
            </Button>
          )}
          <Tooltip content={`取消上传 ${file.file.name}`}>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`取消上传 ${file.file.name}`}
              onClick={() => {
                void onCancel(file).catch((e) => setError(errorMessage(e)));
              }}
            >
              <Icon name="close" size={14} />
            </Button>
          </Tooltip>
        </div>
      ))}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
export function AttachmentPreview({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose(): void;
}) {
  return attachment.kind === "pdf" ? (
    <PdfPreview key={attachment.id} attachment={attachment} onClose={onClose} />
  ) : attachment.kind === "docx" || attachment.kind === "table" ? (
    <OfficePreview
      key={attachment.id}
      attachment={attachment}
      onClose={onClose}
    />
  ) : (
    <BasicAttachmentPreview
      key={attachment.id}
      attachment={attachment}
      onClose={onClose}
    />
  );
}
function BasicAttachmentPreview({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose(): void;
}) {
  const [content, setContent] = useState<AttachmentContent | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [attempt, setAttempt] = useState(0),
    [saving, setSaving] = useState(false),
    [mediaUrl, setMediaUrl] = useState("");
  useEffect(() => {
    if (
      !content ||
      (content.attachment.kind !== "audio" &&
        content.attachment.kind !== "video")
    ) {
      setMediaUrl("");
      return;
    }
    let url = "";
    try {
      const binary = atob(content.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++)
        bytes[index] = binary.charCodeAt(index);
      url = URL.createObjectURL(
        new Blob([bytes], { type: content.attachment.mime }),
      );
      setMediaUrl(url);
    } catch {
      setError("无法读取音视频内容。");
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [content]);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");
    void desktop
      .attachmentContent({
        id: attachment.id,
        conversationId: attachment.conversationId,
      })
      .then((value) => {
        if (!disposed) setContent(attachmentContentSchema.parse(value));
      })
      .catch((e) => {
        if (!disposed) setError(errorMessage(e));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [attachment.id, attachment.conversationId, attempt]);
  let text = "";
  if (content?.attachment.kind === "text") {
    const binary = atob(content.data.slice(0, Math.ceil(262144 / 3) * 4));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    text = new TextDecoder().decode(bytes).slice(0, 65536);
  }
  return (
    <Modal title={attachment.name} onClose={onClose} variant="attachment">
      <div className="attachment-preview">
        {loading && <p role="status">正在读取附件…</p>}
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <Button
              variant="secondary"
              size="sm"
              className="secondary"
              onClick={() => setAttempt((value) => value + 1)}
            >
              重试
            </Button>
          </div>
        ) : (
          content &&
          (content.attachment.kind === "image" ? (
            <img
              src={`data:${content.attachment.mime};base64,${content.data}`}
              alt={attachment.name}
              onError={() =>
                setError("图片无法解码，内容可能损坏。请移除后重新上传。")
              }
            />
          ) : content.attachment.kind === "audio" && mediaUrl ? (
            <audio
              controls
              src={mediaUrl}
              onError={() =>
                setError("无法播放该音频，内容可能损坏。请移除后重新选择。")
              }
            />
          ) : content.attachment.kind === "video" && mediaUrl ? (
            <video
              controls
              src={mediaUrl}
              onError={() =>
                setError("无法播放该视频，内容可能损坏。请移除后重新选择。")
              }
            />
          ) : content.attachment.kind === "file" ? (
            <p role="status">
              已保存的成果文件。这不是已理解的内容，可以保存后查看原始字节。
            </p>
          ) : content.attachment.kind === "text" ? (
            <>
              <pre>{text}</pre>
              {attachment.size > 65536 && (
                <p className="muted">
                  预览最多显示 65,536 个字符，保存附件可查看完整内容。
                </p>
              )}
            </>
          ) : null)
        )}
        <footer>
          <span>{attachment.size} 字节</span>
          <Button
            variant="secondary"
            size="sm"
            className="secondary"
            isDisabled={saving || loading}
            onClick={() => {
              setSaving(true);
              void desktop
                .saveAttachment({
                  id: attachment.id,
                  conversationId: attachment.conversationId,
                })
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setSaving(false));
            }}
          >
            保存附件
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
