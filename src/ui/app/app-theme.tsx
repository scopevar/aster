import { useLayoutEffect, type ReactNode } from "react";

export function AppTheme({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const appearance = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme = appearance.matches
        ? "dark"
        : "light";
    };
    update();
    appearance.addEventListener("change", update);
    return () => appearance.removeEventListener("change", update);
  }, []);
  return children;
}
