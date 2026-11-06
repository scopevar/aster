import type { RefObject } from "react";

/** Shared text entry for local and daemon conversations; transport stays with
 * the caller, including attachment ownership and durable request IDs. */
export function MessageInput({
  input,
  value,
  placeholder,
  disabled,
  onChange,
  onFiles,
  onSend,
}: {
  input: RefObject<HTMLTextAreaElement | null>;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange(value: string): void;
  onFiles(files: File[]): void;
  onSend(): void;
}) {
  return (
    <textarea
      ref={input}
      aria-label="消息"
      placeholder={placeholder}
      disabled={disabled}
      value={value}
      rows={1}
      maxLength={32000}
      onChange={(event) => onChange(event.target.value)}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        if (files.length) {
          event.preventDefault();
          onFiles(files);
        }
      }}
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          onSend();
        }
      }}
    />
  );
}
