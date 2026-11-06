import { Tooltip as HeroTooltip } from "@heroui/react";
import type { ReactElement } from "react";

export function Tooltip({
  children,
  content,
}: {
  children: ReactElement;
  content: string | undefined;
}) {
  if (!content) return children;
  return (
    <HeroTooltip delay={450} closeDelay={80} shouldSkipAnimation>
      {children}
      <HeroTooltip.Content>{content}</HeroTooltip.Content>
    </HeroTooltip>
  );
}
