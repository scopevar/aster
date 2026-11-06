import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import {
  backupStatusSchema,
  type BackupRequest,
  type BackupStatus,
} from "../../../shared/backup.js";
import {
  localWorkspaceStatusSchema,
  type LocalWorkspaceStatus,
} from "../../../shared/local-workspace.js";
import { desktop, envelope, errorMessage } from "../../lib/client.js";
import { Icon } from "../../components/icons.js";
import { IconButton } from "../../components/icon-button.js";
import { toast } from "../../components/toast.js";
import "./settings-backup.css";

export function BackupSettings() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [workspace, setWorkspace] = useState<LocalWorkspaceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void Promise.all([
      desktop.backup({ action: "status" }),
      desktop.localWorkspace({ action: "status" }),
    ])
      .then(([backup, local]) => {
        if (live) {
          setStatus(backupStatusSchema.parse(backup));
          setWorkspace(localWorkspaceStatusSchema.parse(local));
        }
      })
      .catch((cause: unknown) => {
        if (live) setError(errorMessage(cause));
      });
    return () => {
      live = false;
    };
  }, []);
  const run = async (action: BackupRequest["action"]) => {
    setBusy(true);
    setError("");
    try {
      const next = backupStatusSchema.parse(await desktop.backup({ action }));
      setStatus(next);
      if (action !== "status" && next.notice)
        toast.success(next.notice, { timeout: 5000 });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="backup-settings" aria-label="本地数据与备份">
      <section className="settings-section">
        <h2>本地工作区</h2>
        <div className="setting-group backup-panel">
          {workspace && (
            <p className="backup-directory">
              <Icon name="folder" size={20} />
              <code>{workspace.directory}</code>
            </p>
          )}
          {workspace?.backup && (
            <p>
              旧数据迁移备份：<code>{workspace.backup}</code>
            </p>
          )}
        </div>
      </section>
      <section className="settings-section">
        <h2>备份与恢复</h2>
        <div className="setting-group backup-panel">
          <div className="backup-operation">
            <div>
              <h3>导出备份</h3>
              <p>
                包含
                Bot、聊天、附件、技能、任务和插件配置。模型凭据、桌面偏好和沙箱文件需随完整数据目录另行保管。
              </p>
            </div>
            <Button
              size="sm"
              variant="primary"
              isDisabled={busy || !status}
              onPress={() => void run("save")}
            >
              导出本地备份
            </Button>
          </div>
          <div className="backup-operation">
            <div>
              <h3>恢复备份</h3>
              <p>
                替换当前数据库，恢复后的任务暂停，目录授权和插件工具需重新确认。恢复前请先导出当前备份。
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy || !status}
              onPress={() => void run("schedule")}
            >
              从备份恢复
            </Button>
          </div>
          <div className="backup-actions">
            {status?.previousAvailable && (
              <Button
                size="sm"
                variant="secondary"
                isDisabled={busy}
                onPress={() => void run("schedule-previous")}
              >
                恢复替换前数据库
              </Button>
            )}
            <IconButton
              aria-label="刷新备份状态"
              isDisabled={busy}
              onPress={() => void run("status")}
            >
              <Icon name="refresh" size={15} />
            </IconButton>
          </div>
          {status?.pending && (
            <>
              <p>
                已安排恢复。明确停止后台后重新打开应用才会执行；仅关闭窗口不会重启后台。
              </p>
              <Button
                size="sm"
                variant="danger"
                isDisabled={busy}
                onPress={() => {
                  setBusy(true);
                  void desktop
                    .command(envelope({ type: "worker.stop" }))
                    .catch((cause: unknown) => {
                      setError(errorMessage(cause));
                      setBusy(false);
                    });
                }}
              >
                停止 daemon 并关闭
              </Button>
            </>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      </section>
    </section>
  );
}
