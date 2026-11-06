import { Button } from "@heroui/react";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { AgentConnection } from "../../../shared/agent-connections.js";
import type { ProviderPreset } from "../connections/provider-presets.js";
import { useSettingsMutation } from "./settings-data.js";

type SectionPage =
  | { screen: "list" | "picker" }
  | {
      screen: "editor";
      editor: {
        originalId: string | null;
        connection: AgentConnection;
        preset: ProviderPreset | null;
      };
    };
export type SettingsDetail = {
  title: string;
  backLabel: string;
  disabled: boolean;
  onBack(): void;
};
const Context = createContext<{
  page: SectionPage;
  navigate: Dispatch<SetStateAction<SectionPage>>;
  error: string;
  setError: Dispatch<SetStateAction<string>>;
  back(): void;
} | null>(null);

export function useSettingsSection() {
  const section = useContext(Context);
  if (!section) throw Error("设置导航需要在设置分类中使用。");
  return section;
}

export function SettingsSection({
  tab,
  description,
  detail: suppliedDetail,
  children,
}: {
  tab: string;
  description: string | undefined;
  detail: SettingsDetail | null;
  children: ReactNode;
}) {
  const [page, navigate] = useState<SectionPage>({ screen: "list" });
  const [error, setError] = useState("");
  const { busy } = useSettingsMutation();
  const blocked = busy.has("connections");
  const back = useCallback(() => {
    if (blocked) return;
    setError("");
    navigate({ screen: "list" });
  }, [blocked]);
  let detail = suppliedDetail;
  if (
    tab === "模型与连接" &&
    page.screen === "editor" &&
    page.editor.originalId !== null
  ) {
    detail = {
      title: "编辑供应商",
      backLabel: "返回供应商列表",
      disabled: blocked,
      onBack: back,
    };
  }
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [detail?.title]);
  return (
    <Context value={{ page, navigate, error, setError, back }}>
      <main className="settings-panel" aria-label={tab}>
        <header className="settings-header">
          <nav className="settings-breadcrumb" aria-label="设置路径">
            <ol>
              <li>设置</li>
              <li aria-hidden="true">/</li>
              <li aria-current={detail ? undefined : "page"}>
                {detail ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="settings-breadcrumb-link"
                    aria-label={detail.backLabel}
                    isDisabled={detail.disabled}
                    onPress={detail.onBack}
                  >
                    {tab}
                  </Button>
                ) : (
                  <h1 className="settings-title" title={description}>
                    {tab}
                  </h1>
                )}
              </li>
              {detail && (
                <>
                  <li aria-hidden="true">/</li>
                  <li aria-current="page">
                    <h1 className="settings-title">{detail.title}</h1>
                  </li>
                </>
              )}
            </ol>
          </nav>
        </header>
        <div ref={content} className="settings-content">
          <div className="settings-content-inner">{children}</div>
        </div>
      </main>
    </Context>
  );
}
