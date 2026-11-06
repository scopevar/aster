import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import type { Bot } from "../../../shared/chat/bots.js";
import type { CommandResult } from "../../../shared/core.js";
import { AvatarEditorView } from "./avatar-editor-view.js";
import { useAvatarEditor } from "./use-avatar-editor.js";

export function AvatarEditor({
  anchor,
  bot,
  act,
  onClose,
}: {
  anchor: HTMLElement;
  bot: Bot;
  act(command: Command, request?: Envelope): Promise<CommandResult | undefined>;
  onClose(): void;
}) {
  const model = useAvatarEditor({ anchor, bot, act, onClose });
  return <AvatarEditorView {...model} />;
}
