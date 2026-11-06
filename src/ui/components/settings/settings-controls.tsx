import { Disclosure } from "../disclosure.js";
import { ListBox, SearchField, Select, Switch } from "@heroui/react";
import { type ReactNode, type Ref } from "react";
import { Icon } from "../icons.js";
import "./settings-controls.css";

export function SettingsDisclosure({
  title,
  children,
  className = "",
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Disclosure
      className={`settings-disclosure ${className}`}
      title={<span className="settings-disclosure-title">{title}</span>}
    >
      <div className="settings-disclosure-body">{children}</div>
    </Disclosure>
  );
}

export function SettingsSelect({
  label,
  name,
  value,
  options,
  disabled = false,
  className = "",
  onChange,
  triggerRef,
}: {
  label: string;
  name?: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  className?: string;
  onChange?(value: string): void;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <Select
      variant="secondary"
      aria-label={label}
      {...(name ? { name } : {})}
      disabledKeys={options
        .filter((option) => option.disabled)
        .map((option) => option.value)}
      className={`settings-select ${className}`}
      value={value}
      isDisabled={disabled}
      onChange={(key) => {
        if (typeof key === "string") onChange?.(key);
      }}
    >
      <Select.Trigger ref={triggerRef}>
        <Select.Value />
        <Select.Indicator>
          <Icon name="chevron-down" size={16} />
        </Select.Indicator>
      </Select.Trigger>
      <Select.Popover className="settings-select-popover" maxHeight={320}>
        <ListBox
          onFocus={(event) => {
            if (event.target instanceof HTMLElement)
              event.target.scrollIntoView({ block: "nearest" });
          }}
        >
          {options.map((option) => (
            <ListBox.Item
              key={option.value}
              id={option.value}
              textValue={option.label}
            >
              {option.label}
              <ListBox.ItemIndicator>
                {({ isSelected }) =>
                  isSelected ? <Icon name="check" size={16} /> : null
                }
              </ListBox.ItemIndicator>
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export function SettingsSearch({
  label,
  placeholder,
  autoFocus = false,
  value,
  onChange,
  className = "",
}: {
  label: string;
  placeholder: string;
  autoFocus?: boolean;
  value: string;
  onChange(value: string): void;
  className?: string;
}) {
  return (
    <SearchField
      variant="secondary"
      aria-label={label}
      className={`settings-search-field ${className}`}
      value={value}
      onChange={onChange}
    >
      <SearchField.Group>
        <SearchField.SearchIcon>
          <Icon name="search" size={16} />
        </SearchField.SearchIcon>
        <SearchField.Input placeholder={placeholder} autoFocus={autoFocus} />
        <SearchField.ClearButton aria-label="清空搜索">
          <Icon name="close" size={16} />
        </SearchField.ClearButton>
      </SearchField.Group>
    </SearchField>
  );
}

export function SettingsSwitch({
  label,
  selected,
  disabled = false,
  busy = false,
  onChange,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChange?(selected: boolean): void;
}) {
  return (
    <div className="settings-switch" aria-busy={busy}>
      <Switch
        aria-label={label}
        isSelected={selected}
        isDisabled={disabled}
        isReadOnly={busy}
        onChange={(selected) => onChange?.(selected)}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    </div>
  );
}
