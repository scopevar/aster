import { Button, Input } from "@heroui/react";
import { useId, useState, type KeyboardEvent } from "react";
import type {
  DesktopPreferences,
  PreferencesChange,
} from "../../../shared/desktop/preferences.js";
import {
  shortcutSchema,
  shortcutLabel,
  type Shortcut,
} from "../../../shared/desktop/shortcut.js";
import { errorMessage } from "../../lib/client.js";
import { Icon } from "../../components/icons.js";
import "./shortcut-settings.css";

export function ShortcutSettings({
  preferences,
  onSave,
}: {
  preferences: DesktopPreferences | null;
  onSave(change: PreferencesChange): Promise<void>;
}) {
  const [draft, setDraft] = useState<Shortcut | null>(null);
  const shortcut = draft ?? preferences?.shortcut ?? null;
  const [recording, setRecording] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const fieldId = useId();
  const state = preferences?.shortcutStatus.state;
  const canSave =
    shortcut &&
    (shortcutLabel(shortcut) !== shortcutLabel(preferences?.shortcut ?? null) ||
      state === "unavailable");
  const capture = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.key === "Process") return;
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setDraft(null);
      setRecording(false);
      setError("");
      event.currentTarget.blur();
      return;
    }
    if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
    const key = event.code.startsWith("Key")
      ? event.code.slice(3)
      : event.code.startsWith("Digit")
        ? event.code.slice(5)
        : event.code;
    const parsed = shortcutSchema.safeParse({
      control: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      key,
    });
    if (event.metaKey || !parsed.success) {
      setError(
        "请使用 Ctrl 或 Alt，搭配字母、数字、空格或 F1–F24；可加 Shift。",
      );
      return;
    }
    setDraft(parsed.data);
    setError("");
  };
  const save = async (shortcut: Shortcut | null) => {
    if (!preferences || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave({ revision: preferences.revision, shortcut });
      setDraft(null);
      setRecording(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shortcut-settings" aria-label="全局快捷键设置">
      <div className="shortcut-summary">
        <span className="shortcut-symbol">
          <Icon name="keyboard" size={22} />
        </span>
        <div className="shortcut-description">
          <h3>打开主窗口</h3>
          <p>在其他应用中，也能快速唤起 Aster。</p>
        </div>
        <span className="shortcut-badge" data-state={state}>
          {!preferences
            ? "读取中"
            : state === "active"
              ? "已启用"
              : state === "unavailable"
                ? "未生效"
                : "未启用"}
        </span>
      </div>
      <div className="shortcut-editor">
        <label htmlFor={fieldId}>快捷键组合</label>
        <div className="shortcut-controls">
          <Input
            id={fieldId}
            className="shortcut-recorder"
            variant="secondary"
            aria-label="打开窗口快捷键"
            aria-describedby={`${fieldId}-hint${error ? ` ${fieldId}-error` : ""}`}
            aria-invalid={!!error}
            data-recording={recording}
            placeholder={recording ? "请按组合键…" : "点击录制快捷键"}
            readOnly
            value={shortcut ? shortcutLabel(shortcut) : ""}
            disabled={!preferences || busy}
            onFocus={() => setRecording(true)}
            onBlur={() => setRecording(false)}
            onKeyDown={capture}
          />
          {canSave && (
            <Button
              variant="primary"
              isDisabled={!preferences || busy}
              onPress={() => void save(shortcut)}
            >
              {busy ? "保存中…" : "保存快捷键"}
            </Button>
          )}
          {preferences?.shortcut && (
            <Button
              variant="ghost"
              isDisabled={busy}
              onPress={() => void save(null)}
            >
              关闭快捷键
            </Button>
          )}
        </div>
        <p className="shortcut-hint" id={`${fieldId}-hint`}>
          {recording
            ? "按下组合键，完成后点击保存。按 Esc 取消。"
            : "点击输入框开始录制，使用 Ctrl 或 Alt 搭配字母、数字或功能键。"}
        </p>
        {error && (
          <p className="shortcut-error" id={`${fieldId}-error`} role="alert">
            {error}
          </p>
        )}
      </div>
      {preferences && (
        <div className="shortcut-status" data-state={state}>
          <Icon name={state === "active" ? "check" : "info"} size={14} />
          <p role="status">{preferences.shortcutStatus.detail}</p>
        </div>
      )}
    </div>
  );
}
