import { Tooltip } from "../../components/tooltip.js";
import { Button } from "@heroui/react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type {
  SkillReference,
  SkillSummary,
} from "../../../shared/tools/skills.js";
import { Icon } from "../../components/icons.js";
import { errorMessage } from "../../lib/client.js";
export type ComposerAction = {
  id: string;
  name: string;
  description: string;
  disabled?: boolean;
} & (
  | { run(): void; prepare?: never }
  | { prepare(): Promise<void>; run?: never }
);
type Choice =
  | { kind: "skill"; value: SkillSummary }
  | { kind: "action"; value: ComposerAction };
export function SkillInput({
  children,
  skills,
  selected,
  input,
  disabled,
  onSelect,
  onManage,
  onPreview,
  actions = [],
  onError,
}: {
  children: ReactNode;
  skills: SkillSummary[];
  selected: SkillSummary[];
  input: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  onSelect(refs: SkillReference[], text: string): Promise<boolean>;
  onManage(): void;
  onPreview(skill: SkillSummary): void;
  actions?: ComposerAction[];
  onError(message: string): void;
}) {
  const root = useRef<HTMLDivElement>(null),
    restore = useRef(false),
    pendingAction = useRef<ComposerAction | null>(null),
    mounted = useRef(false),
    locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const menuId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [menu, setMenu] = useState<{
      start: number;
      end: number;
      query: string;
    } | null>(null),
    [active, setActive] = useState(0),
    [saving, setSaving] = useState(false);
  const matches = (name: string, description: string) =>
    `${name} ${description}`
      .toLocaleLowerCase()
      .includes(menu?.query.toLocaleLowerCase() ?? "");
  const choices: Choice[] = [
    ...skills
      .filter(
        (s) =>
          !selected.some((r) => r.id === s.id) &&
          matches(s.name, s.description),
      )
      .map((value): Choice => ({ kind: "skill", value })),
    ...actions
      .filter((a) => matches(a.name, a.description))
      .map((value): Choice => ({ kind: "action", value })),
  ].sort((a, b) => {
    const query = menu?.query.toLocaleLowerCase() ?? "";
    const rank = (choice: Choice) => {
      const name = choice.value.name.toLocaleLowerCase();
      return name.startsWith(query) ? 0 : name.includes(query) ? 1 : 2;
    };
    return rank(a) - rank(b);
  });
  // The original menu exposes eight candidates; searching reveals the rest.
  // Keep one slot for this app's explicit skill editor entry.
  choices.splice(7);
  choices.push({
    kind: "action",
    value: {
      id: "manage-skills",
      name: "管理技能",
      description: "创建与编辑",
      run: onManage,
    },
  });
  const activeIndex = Math.min(active, choices.length - 1);
  const expanded = menu !== null;
  useLayoutEffect(() => {
    if (!expanded) return;
    const place = () => {
      const anchor = root.current?.getBoundingClientRect();
      const bounds = panel.current?.getBoundingClientRect();
      if (!anchor || !bounds) return;
      setPosition({
        left: Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8)),
        top: Math.max(
          8,
          Math.min(
            anchor.top - bounds.height - 6,
            innerHeight - bounds.height - 8,
          ),
        ),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (root.current) observer.observe(root.current);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [expanded]);
  useLayoutEffect(() => {
    const editor = input.current;
    if (!menu || !editor) return;
    const attributes = [
      "aria-controls",
      "aria-expanded",
      "aria-activedescendant",
    ];
    const previous = attributes.map((name) => editor.getAttribute(name));
    editor.setAttribute("aria-controls", menuId);
    editor.setAttribute("aria-expanded", "true");
    editor.setAttribute("aria-activedescendant", `${menuId}-${activeIndex}`);
    document
      .getElementById(`${menuId}-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
    return () => {
      // The nested @ picker may have taken ownership while the slash menu closed.
      if (editor.getAttribute("aria-controls") !== menuId) return;
      attributes.forEach((name, index) => {
        const value = previous[index];
        if (value == null) editor.removeAttribute(name);
        else editor.setAttribute(name, value);
      });
    };
  }, [menu, menuId, activeIndex, input]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (
        e.target instanceof Node &&
        !root.current?.contains(e.target) &&
        !panel.current?.contains(e.target)
      )
        setMenu(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  useEffect(() => {
    if (!disabled && !saving && pendingAction.current) {
      const action = pendingAction.current;
      pendingAction.current = null;
      input.current?.focus();
      action.run?.();
      return;
    }
    if (!disabled && !saving && restore.current) {
      restore.current = false;
      input.current?.focus();
    }
  }, [disabled, saving, input]);
  const save = async (
    refs: SkillReference[],
    text: string,
    action?: ComposerAction,
  ) => {
    if (locked.current || disabled) return false;
    locked.current = true;
    setSaving(true);
    try {
      await action?.prepare?.();
      if (!mounted.current) return false;
      if (
        await onSelect(
          refs.map(({ id, botId, revision }) => ({ id, botId, revision })),
          text,
        )
      ) {
        if (!mounted.current) return false;
        setMenu(null);
        restore.current = !action;
        // Navigation owns focus; a delayed input focus would steal it from the new panel.
        pendingAction.current = action ?? null;
        return true;
      }
      return false;
    } catch (error) {
      if (mounted.current) onError(errorMessage(error));
      return false;
    } finally {
      locked.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const choose = (choice: Choice | undefined) => {
    if (!choice || !menu || locked.current || disabled) return;
    if (choice.kind === "skill" && selected.length >= 4) return;
    if (choice.kind === "action" && choice.value.disabled) return;
    const text = input.current?.value ?? "";
    if (text.slice(menu.start, menu.end) !== `/${menu.query}`) {
      setMenu(null);
      return;
    }
    const next = text.slice(0, menu.start) + text.slice(menu.end);
    if (choice.kind === "skill") void save([...selected, choice.value], next);
    else void save(selected, next, choice.value);
  };
  const updateMenu = (editor: HTMLTextAreaElement) => {
    const caret = editor.selectionStart,
      match = /(?:^|\s)\/([^\s/]*)$/.exec(editor.value.slice(0, caret));
    setMenu(
      match?.[1] !== undefined
        ? { start: caret - match[1].length - 1, end: caret, query: match[1] }
        : null,
    );
    setActive(0);
  };
  return (
    <div
      className="skill-input"
      ref={root}
      onInput={(e) => {
        if (
          !(e.target instanceof HTMLTextAreaElement) ||
          (e.nativeEvent instanceof InputEvent && e.nativeEvent.isComposing)
        )
          return;
        updateMenu(e.target);
      }}
      onCompositionEnd={(e) => {
        // Windows can commit its final input with isComposing=true and no later input.
        if (e.target instanceof HTMLTextAreaElement) updateMenu(e.target);
      }}
      onKeyDownCapture={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (menu) {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setMenu(null);
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            setActive(
              (n) =>
                (n + (e.key === "ArrowDown" ? 1 : -1) + choices.length) %
                choices.length,
            );
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            choose(choices[activeIndex]);
          } else if (e.key === "Tab") {
            setMenu(null);
          }
        } else if (
          e.key === "Backspace" &&
          !input.current?.value &&
          selected.length
        ) {
          e.preventDefault();
          e.stopPropagation();
          void save(selected.slice(0, -1), "");
        }
      }}
    >
      {selected.length > 0 && (
        <div className="skill-chips">
          {selected.map((s) => (
            <span className="skill-chip" key={s.id}>
              <Tooltip content={`v${s.revision}`}>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => onPreview(s)}
                >
                  <Icon name="skill" size={13} /> {s.name}
                </Button>
              </Tooltip>
              <Tooltip content={`移除技能引用 ${s.name}`}>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  isDisabled={disabled || saving}
                  aria-label={`移除技能引用 ${s.name}`}
                  onClick={() => {
                    void save(
                      selected.filter((r) => r.id !== s.id),
                      input.current?.value ?? "",
                    );
                  }}
                >
                  <Icon name="close" size={10} />
                </Button>
              </Tooltip>
            </span>
          ))}
        </div>
      )}
      {children}
      {menu &&
        createPortal(
          <div
            ref={panel}
            style={position}
            className="skill-menu"
            role="listbox"
            aria-label="引用技能"
            id={menuId}
          >
            {choices.map((choice, i) => (
              <button
                key={`${choice.kind}:${choice.value.id}`}
                role="option"
                id={`${menuId}-${i}`}
                aria-selected={activeIndex === i}
                tabIndex={-1}
                disabled={
                  disabled ||
                  saving ||
                  (choice.kind === "action" && choice.value.disabled) ||
                  (choice.kind === "skill" && selected.length >= 4)
                }
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => {
                  if (!disabled && !saving) setActive(i);
                }}
                onClick={() => choose(choice)}
              >
                {choice.kind === "skill" ? (
                  <Icon name="skill" size={14} />
                ) : (
                  <Icon
                    name="command"
                    size={14}
                    className="composer-action-icon"
                  />
                )}
                <strong>{choice.value.name}</strong>
                <span className="skill-menu-description">
                  {choice.value.description}
                </span>
                <small>{choice.kind === "skill" ? "技能" : "操作"}</small>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
