import { Toast } from "@heroui/react";
import "./toast.css";

export { toast } from "@heroui/react";

export function AppToaster() {
  return (
    <Toast.Provider
      className="app-toaster"
      placement="top"
      width={356}
      maxVisibleToasts={3}
      aria-label="通知"
    >
      {({ toast }) => (
        <Toast toast={toast} variant={toast.content.variant}>
          <Toast.Indicator variant={toast.content.variant} />
          <Toast.Content>
            <Toast.Title>{toast.content.title}</Toast.Title>
          </Toast.Content>
          <Toast.CloseButton aria-label="关闭提示" />
        </Toast>
      )}
    </Toast.Provider>
  );
}
