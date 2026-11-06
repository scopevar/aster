import { Modal as HeroModal } from "@heroui/react";
import type { ReactNode } from "react";
import { Icon } from "./icons.js";
import { Tooltip } from "./tooltip.js";

function AppModal({
  title,
  onClose,
  children,
  wide = false,
  variant,
  className = "",
  id,
  subtitle,
  actions,
  hideHeader = false,
  hideCloseButton = false,
  busy = false,
  closeLabel = "关闭弹窗",
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
  variant?:
    | "market"
    | "search-palette"
    | "attachment"
    | "pdf"
    | "office"
    | "delete-confirm"
    | "template-preview-detail"
    | "bot-settings";
  className?: string;
  id?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  hideHeader?: boolean;
  hideCloseButton?: boolean;
  busy?: boolean;
  closeLabel?: string;
}) {
  return (
    <HeroModal
      isOpen
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <HeroModal.Backdrop
        className="app-modal-backdrop"
        isDismissable={!busy}
        isKeyboardDismissDisabled={busy}
      >
        <HeroModal.Container
          size={variant === "pdf" || variant === "office" ? "full" : "lg"}
          placement="center"
          scroll="inside"
          className="app-modal-container"
        >
          <HeroModal.Dialog
            {...(id ? { id } : {})}
            aria-label={title}
            className={`modal ${wide ? "wide" : ""} ${variant ?? ""} ${className}`}
          >
            {!hideHeader && (
              <header className="app-modal-header">
                <div className="app-modal-heading">
                  <HeroModal.Heading>{title}</HeroModal.Heading>
                  {subtitle}
                </div>
                {actions}
              </header>
            )}
            {!hideCloseButton && (
              <Tooltip content={closeLabel}>
                <HeroModal.CloseTrigger
                  aria-label={closeLabel}
                  isDisabled={busy}
                >
                  <Icon name="close" size={16} />
                </HeroModal.CloseTrigger>
              </Tooltip>
            )}
            {children}
          </HeroModal.Dialog>
        </HeroModal.Container>
      </HeroModal.Backdrop>
    </HeroModal>
  );
}

export const Modal = Object.assign(AppModal, {
  Body: HeroModal.Body,
  Footer: HeroModal.Footer,
});
