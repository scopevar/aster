import { Button } from "@heroui/react";
import type { ComponentProps } from "react";
import { Tooltip } from "./tooltip.js";

export function IconButton({
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "isIconOnly"> & {
  "aria-label": string;
}) {
  return (
    <Tooltip content={props["aria-label"]}>
      <Button variant="ghost" size="sm" {...props} isIconOnly>
        {children}
      </Button>
    </Tooltip>
  );
}
