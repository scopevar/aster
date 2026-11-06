import { IconButton } from "./icon-button.js";
import { Icon } from "./icons.js";

export function ComposerMenu({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles(): void;
}) {
  return (
    <IconButton
      variant="ghost"
      className="icon-button attach"
      aria-label="添加附件"
      isDisabled={disabled}
      onPress={onFiles}
    >
      <Icon name="plus" size={22} />
    </IconButton>
  );
}
