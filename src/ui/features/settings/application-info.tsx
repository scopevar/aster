import { Button, Disclosure } from "@heroui/react";
import { useEffect, useState } from "react";
import { Icon } from "../../components/icons.js";
import { appUpdate } from "../../lib/client.js";
import { LicenseBrowser } from "./license-browser.js";
import { useSettingsData } from "./settings-data.js";
import "./application-info.css";

export function ApplicationInfo() {
  const [state, , readState] = useSettingsData("updates");
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [licensesOpen, setLicensesOpen] = useState(false);
  const [licensesRequested, setLicensesRequested] = useState(false);
  useEffect(() => {
    let active = true;
    if (!state)
      void readState(() => appUpdate({ action: "state" })).catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [readState, attempt]);
  return (
    <div className="application-info">
      <section className="application-info-card" aria-label="应用版本和版权">
        <div className="application-info-brand">
          <img src="./assets/aster-avatar.png" alt="" draggable={false} />
          <div>
            <h2>Aster</h2>
            <p className="application-info-version" role="status">
              {state
                ? `本地版 · v${state.currentVersion}`
                : unavailable
                  ? "版本信息暂不可用"
                  : "正在读取版本…"}
            </p>
          </div>
        </div>
        {unavailable && !state && (
          <Button
            variant="ghost"
            size="sm"
            onPress={() => {
              setUnavailable(false);
              setAttempt((value) => value + 1);
            }}
          >
            重新读取版本
          </Button>
        )}
        <p className="application-info-description">
          你的本地桌面 AI 助手。使用自己的模型，数据保存在本机。
        </p>
        <p className="application-info-copyright">
          © 2026 scopevar · GPL-3.0-only
        </p>
      </section>
      <Disclosure
        className="settings-disclosure"
        isExpanded={licensesOpen}
        onExpandedChange={(open) => {
          setLicensesOpen(open);
          if (open) setLicensesRequested(true);
        }}
      >
        <Disclosure.Heading>
          <Disclosure.Trigger className="app-disclosure-trigger">
            <span className="settings-disclosure-title">
              <Icon name="book" size={18} />
              第三方许可
            </span>
            <Disclosure.Indicator>
              <Icon name="chevron-down" size={14} />
            </Disclosure.Indicator>
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body>
            <div className="settings-disclosure-body">
              {licensesRequested && <LicenseBrowser />}
            </div>
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </div>
  );
}
