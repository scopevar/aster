import { Modal } from "../../components/modal.js";
import { useId, useLayoutEffect, type ReactNode } from "react";
import "./add-connection-dialog.css";

export function AddConnectionDialog({
  choosing,
  busy,
  onClose,
  children,
}: {
  choosing: boolean;
  busy: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const dialogId = useId();
  useLayoutEffect(() => {
    document.getElementById(dialogId)?.focus({ preventScroll: true });
  }, [dialogId, choosing]);
  return (
    <Modal
      id={dialogId}
      title="添加连接"
      onClose={onClose}
      busy={busy}
      closeLabel="关闭添加连接"
      className="connection-add-dialog"
      hideHeader={!choosing}
      subtitle={<p>选择模型服务商，或配置兼容接口。</p>}
    >
      <Modal.Body key={choosing ? "picker" : "editor"}>{children}</Modal.Body>
    </Modal>
  );
}
