import { useLayoutEffect, useRef, type ReactNode } from "react";

export function MainPage({
  hidden,
  columns,
  children,
}: {
  hidden: boolean;
  columns: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    if (hidden) {
      source.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    element.hidden = hidden;
    if (!hidden) {
      if (source.current?.isConnected)
        source.current.focus({ preventScroll: true });
      source.current = null;
    }
  }, [hidden]);
  return (
    <div
      ref={root}
      className="main-page"
      style={{ gridTemplateColumns: columns }}
    >
      {children}
    </div>
  );
}
