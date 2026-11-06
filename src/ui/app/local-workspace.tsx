import { useEffect, useState, type ReactNode } from "react";
import { Button, Radio, RadioGroup } from "@heroui/react";
import { AppError } from "../../shared/core.js";
import {
  localWorkspaceStatusSchema,
  type LocalWorkspaceStatus,
} from "../../shared/local-workspace.js";
import { desktop, errorMessage } from "../lib/client.js";
import { AppStartup } from "./app-startup.js";
import { AppTitlebar } from "../components/window/app-titlebar.js";
import { Icon } from "../components/icons.js";
import "./local-workspace.css";

export function LocalWorkspaceGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LocalWorkspaceStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedSource, setSelectedSource] = useState<string>();
  const load = () =>
    desktop
      .localWorkspace({ action: "status" })
      .then((value) => setStatus(localWorkspaceStatusSchema.parse(value)))
      .catch((cause: unknown) =>
        setError(
          cause instanceof AppError && cause.code === "not_found"
            ? "当前后台不支持本地工作区。请从托盘选择“停止 daemon 并关闭”，再重新启动应用。"
            : errorMessage(cause),
        ),
      );
  useEffect(() => {
    void load();
  }, []);
  const select = async (source: string | null) => {
    setBusy(true);
    setError("");
    try {
      setStatus(
        localWorkspaceStatusSchema.parse(
          await desktop.localWorkspace({ action: "select", source }),
        ),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  if (status?.ready) return children;
  const chain = { current: Promise.resolve() };
  if (!status && !error) return <AppStartup chain={chain} onError={setError} />;
  const hasSources = Boolean(status?.sources.length);
  return (
    <div className="app">
      <AppTitlebar chain={chain} onError={setError} />
      <main className="local-workspace-page" aria-label="选择本地工作区">
        <section className="local-workspace-panel">
          <header className="local-workspace-heading">
            <span className="local-workspace-symbol">
              <Icon name={status ? "drive" : "info"} size={22} />
            </span>
            {!status && <h1>无法打开本地工作区</h1>}
            {status && <h1>{hasSources ? "选择旧数据" : "打开本地工作区"}</h1>}
            {hasSources && (
              <p>选择一份迁移到本地工作区。迁移前会自动备份，原目录保留。</p>
            )}
            {status && !hasSources && (
              <p>工作区尚未打开，请重试。已有数据不会被覆盖。</p>
            )}
          </header>
          {hasSources && (
            <RadioGroup
              variant="secondary"
              className="local-workspace-sources"
              aria-label="旧数据目录"
              isDisabled={busy}
              value={selectedSource ?? ""}
              onChange={setSelectedSource}
            >
              {status?.sources.map((source) => (
                <Radio
                  className="local-workspace-option"
                  key={source.id}
                  value={source.id}
                  aria-label={source.label}
                >
                  <Radio.Content>
                    <Icon name="folder" size={20} />
                    <span className="local-workspace-copy">
                      <strong>{source.label}</strong>
                      <code>{source.directory}</code>
                    </span>
                    <Radio.Control>
                      <Radio.Indicator />
                    </Radio.Control>
                  </Radio.Content>
                </Radio>
              ))}
            </RadioGroup>
          )}
          {status && !hasSources && (
            <code className="local-workspace-directory">
              {status.directory}
            </code>
          )}
          {error && (
            <p role="alert" className="local-workspace-error">
              {error}
            </p>
          )}
          {busy && (
            <p role="status" className="local-workspace-progress">
              正在备份并准备工作区，请勿关闭应用…
            </p>
          )}
          <footer>
            {hasSources && (
              <>
                <div className="local-workspace-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    isDisabled={busy}
                    onPress={() => void select(null)}
                  >
                    创建空白工作区
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    isDisabled={busy || selectedSource === undefined}
                    onPress={() => {
                      if (selectedSource !== undefined)
                        void select(selectedSource);
                    }}
                  >
                    {busy ? "正在迁移…" : "迁移并进入"}
                  </Button>
                </div>
                <p className="local-workspace-hint">
                  其他目录可从“数据与备份”导入，恢复会替换当前数据库。
                </p>
              </>
            )}
            {status && !hasSources && (
              <Button
                variant="primary"
                size="sm"
                isDisabled={busy}
                onPress={() => void select(null)}
              >
                重试打开本地工作区
              </Button>
            )}
            {!status && (
              <Button
                variant="secondary"
                size="sm"
                onPress={() => {
                  setError("");
                  void load();
                }}
              >
                重试连接
              </Button>
            )}
          </footer>
        </section>
      </main>
    </div>
  );
}
