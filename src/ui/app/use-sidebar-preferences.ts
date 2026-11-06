import { useState } from "react";
export function useSidebarPreferences() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("sidebarCollapsed") === "true",
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const n = Number(localStorage.getItem("sidebarWidth"));
    return n >= 240 && n <= 400 ? n : 280;
  });
  function resize(width: number, collapsed: boolean) {
    setSidebarWidth(width);
    setSidebarCollapsed(collapsed);
    localStorage.setItem("sidebarWidth", String(width));
    localStorage.setItem("sidebarCollapsed", String(collapsed));
  }
  return { sidebarCollapsed, sidebarWidth, resize };
}
export type SidebarPreferencesViewModel = ReturnType<
  typeof useSidebarPreferences
>;
