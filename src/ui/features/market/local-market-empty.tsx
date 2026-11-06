import type { ReactNode } from "react";
import { Icon, type IconName } from "../../components/icons.js";

export function LocalMarketEmpty({
  icon,
  title,
  children,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="local-market-empty" role="status">
      <Icon name={icon} size={30} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}
