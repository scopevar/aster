import { Disclosure as HeroDisclosure } from "@heroui/react";
import type { ReactNode } from "react";
import { Icon } from "./icons.js";

export function Disclosure({
  title,
  children,
  className = "",
  defaultExpanded = false,
  ...props
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  defaultExpanded?: boolean;
  "aria-label"?: string;
}) {
  return (
    <HeroDisclosure
      className={`app-disclosure ${className}`}
      defaultExpanded={defaultExpanded}
      {...props}
    >
      <HeroDisclosure.Heading>
        <HeroDisclosure.Trigger className="app-disclosure-trigger">
          {title}
          <HeroDisclosure.Indicator>
            <Icon name="chevron-down" size={14} />
          </HeroDisclosure.Indicator>
        </HeroDisclosure.Trigger>
      </HeroDisclosure.Heading>
      <HeroDisclosure.Content>
        <HeroDisclosure.Body>{children}</HeroDisclosure.Body>
      </HeroDisclosure.Content>
    </HeroDisclosure>
  );
}
