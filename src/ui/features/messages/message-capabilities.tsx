import { createContext, useContext, type ReactNode } from "react";
import { desktop, execute } from "../../lib/client.js";

type Capabilities = {
  execute: typeof execute;
  plugins: typeof desktop.plugins;
  toolImage: typeof desktop.toolImage;
};
const context = createContext<Capabilities>({
  execute,
  plugins: desktop.plugins,
  toolImage: desktop.toolImage,
});
export function MessageCapabilities({
  value,
  children,
}: {
  value: Capabilities;
  children: ReactNode;
}) {
  return <context.Provider value={value}>{children}</context.Provider>;
}
export const useMessageCapabilities = () => useContext(context);
