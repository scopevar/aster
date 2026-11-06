import { processDiagnosticsSchema } from "../shared/diagnostics.js";

/** Explicit numeric and resource-type allowlist; never copy env, argv, paths or errors. */
export function processDiagnostics() {
  const memory = process.memoryUsage(),
    cpu = process.cpuUsage();
  const resources = new Map<string, number>();
  for (const type of process.getActiveResourcesInfo()) {
    const safe = /^[A-Za-z0-9_-]{1,80}$/.test(type) ? type : "other";
    resources.set(safe, (resources.get(safe) ?? 0) + 1);
  }
  return processDiagnosticsSchema.parse({
    uptimeSeconds: Math.floor(process.uptime()),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    cpuUserMicroseconds: cpu.user,
    cpuSystemMicroseconds: cpu.system,
    resources: [...resources]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, count]) => ({ type, count })),
  });
}
