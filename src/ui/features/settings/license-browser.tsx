import { Button } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import "./license-browser.css";

export function LicenseBrowser() {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const sections = useMemo(() => text?.split(/(?<=\n-{72}\n)/) ?? [], [text]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("./THIRD_PARTY_LICENSES.txt", {
          signal: controller.signal,
        });
        if (!response.ok) throw Error("License file unavailable");
        const content = await response.text();
        if (!content.trim()) throw Error("License file is empty");
        if (!controller.signal.aborted) setText(content);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [attempt]);
  return (
    <div className="license-browser">
      {failed ? (
        <>
          <p role="alert">许可声明读取失败。</p>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              setFailed(false);
              setAttempt((value) => value + 1);
            }}
          >
            重试
          </Button>
        </>
      ) : text ? (
        <div
          className="license-notice"
          tabIndex={0}
          aria-label="第三方许可正文"
        >
          {sections.map((section, index) => (
            <pre key={index}>{section}</pre>
          ))}
        </div>
      ) : (
        <p role="status">正在读取许可声明…</p>
      )}
    </div>
  );
}
