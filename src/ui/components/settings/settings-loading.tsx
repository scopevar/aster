import { Button, Skeleton } from "@heroui/react";
import "./settings-loading.css";

export function SettingsLoading({ label }: { label: string }) {
  return (
    <div className="settings-loading" role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    </div>
  );
}

export function SettingsReadError({
  error,
  onRetry,
}: {
  error: string;
  onRetry(): void;
}) {
  return (
    <div className="settings-read-error" role="alert">
      <p>{error}</p>
      <Button variant="secondary" onPress={onRetry}>
        重新读取
      </Button>
    </div>
  );
}
