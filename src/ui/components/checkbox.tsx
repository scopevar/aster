import { Checkbox as HeroCheckbox, Label } from "@heroui/react";
import type { ComponentProps, ReactNode } from "react";

export function Checkbox({
  children,
  ...props
}: Omit<ComponentProps<typeof HeroCheckbox>, "children"> & {
  children: ReactNode;
}) {
  return (
    <HeroCheckbox {...props}>
      <HeroCheckbox.Content>
        <HeroCheckbox.Control>
          <HeroCheckbox.Indicator />
        </HeroCheckbox.Control>
        <Label>{children}</Label>
      </HeroCheckbox.Content>
    </HeroCheckbox>
  );
}
