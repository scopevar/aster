import type { ReactNode } from "react";
import { Button, Tooltip } from "@heroui/react";
import { Icon } from "../components/icons.js";
import "./navigation-rail.css";

export function NavigationRail({
  active,
  onConversations,
  onMarket,
  children,
}: {
  active: "conversations" | "market";
  onConversations(): void;
  onMarket(): void;
  children: ReactNode;
}) {
  return (
    <aside className="navigation-rail" aria-label="应用侧栏">
      <nav className="navigation-rail-items" aria-label="主导航">
        {(
          [
            ["conversations", "会话", "messages", onConversations],
            ["market", "本地市场", "market", onMarket],
          ] as const
        ).map(([id, label, icon, run]) => (
          <Tooltip key={id}>
            <Button
              variant={active === id ? "tertiary" : "ghost"}
              isIconOnly
              className="navigation-rail-item"
              aria-label={label}
              aria-current={active === id ? "page" : false}
              onPress={run}
            >
              <Icon name={icon} size={22} />
            </Button>
            <Tooltip.Content placement="right">{label}</Tooltip.Content>
          </Tooltip>
        ))}
      </nav>
      {children}
    </aside>
  );
}
