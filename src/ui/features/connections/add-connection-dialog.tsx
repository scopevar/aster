import { Modal } from "../../components/modal.js";
import { useId, useLayoutEffect, type ReactNode } from "react";
import "./add-connection-dialog.css";

export function AddConnectionDialog({
  choosing,
  providerName,
  busy,
  onClose,
  children,
}: {
  choosing: boolean;
  providerName: string | undefined;
  busy: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const dialogId = useId();
  useLayoutEffect(() => {
    document.getElementById(dialogId)?.focus({ preventScroll: true });
  }, [dialogId, choosing]);
  let title = "添加自定义供应商";
  if (choosing) title = "添加连接";
  else if (providerName) title = `添加 ${providerName}`;
  return (
    <Modal
      id={dialogId}
      title={title}
      onClose={onClose}
      busy={busy}
      closeLabel="关闭添加连接"
      className="connection-add-dialog"
      subtitle={
        <p>
          {choosing
            ? "选择模型服务商，或配置兼容接口。"
            : "连接兼容的模型 API，为 Pi Agent 配置可用模型。"}
        </p>
      }
    >
      <Modal.Body key={choosing ? "picker" : "editor"}>{children}</Modal.Body>
    </Modal>
  );
}
