import type { Usage } from "../../../shared/chat/usage.js";

function duration(minutes: number | null) {
  if (minutes === null) return "周期未知";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}
export function UsageView({
  usage,
  timeZone,
}: {
  usage: Usage | undefined;
  timeZone: string;
}) {
  if (!usage) return <p className="settings-note">尚未查询用量。</p>;
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone === "auto" ? {} : { timeZone }),
  });
  return (
    <div className="usage-view" role="region" aria-label="提供商用量">
      <p
        className="settings-note"
        role={usage.status === "unavailable" ? "alert" : undefined}
      >
        {usage.detail}
      </p>
      {usage.windows.map((window) => {
        const remaining =
          window.usedPercent === null
            ? null
            : Math.max(0, Math.min(100, 100 - window.usedPercent));
        return (
          <div key={window.id} className="quota-window">
            <div>
              <strong>{window.name}</strong>
              <span>{duration(window.windowDurationMins)}</span>
              <b>
                {remaining === null
                  ? "剩余额度未知"
                  : `剩余 ${Math.round(remaining)}%`}
              </b>
            </div>
            {remaining !== null && (
              <progress
                aria-label={`${window.name} ${duration(window.windowDurationMins)} 剩余额度`}
                value={remaining}
                max={100}
              />
            )}
            <small>
              {window.resetsAt === null
                ? "重置时间未知"
                : `重置于 ${formatter.format(window.resetsAt * 1000)}`}
            </small>
          </div>
        );
      })}
      <p className="usage-updated">
        查询于 {formatter.format(usage.checkedAt)} · 账户共享额度
      </p>
    </div>
  );
}
