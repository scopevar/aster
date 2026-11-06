import { callWorker } from "../../src/worker/client.js";
import { snapshotUpdateSchema, type Query } from "../../src/shared/snapshot.js";
import { randomUUID } from "node:crypto";
import type { Endpoint } from "../../src/platform/endpoint.js";

/** 不带 since 的 /snapshot 必然返回完整快照；拿不到就是契约被破坏，让用例失败。 */
export function fullSnapshotOf(value: unknown) {
  const update = snapshotUpdateSchema.parse(value);
  if (!update.changed)
    throw new Error("未携带 since 的快照返回了 changed:false");
  return update.snapshot;
}

/**
 * 用例绕过 worker 直接改库时，worker 不知道数据变了，界面也就收不到推送。
 * 经 worker 提交一次无副作用的命令，让它发出变化提示，界面随即重新拉取完整快照。
 */
export async function nudgeWorker(endpoint: Endpoint, conversationId: string) {
  const draft = (await workerSnapshot(endpoint)).conversations.find(
    (item) => item.id === conversationId,
  )?.draft;
  await callWorker(endpoint, "/command", {
    id: randomUUID(),
    command: { type: "draft.save", conversationId, text: draft ?? "" },
  });
}

export async function workerSnapshot(
  endpoint: Endpoint,
  query: Omit<Query, "since"> = {},
) {
  return fullSnapshotOf(await callWorker(endpoint, "/snapshot", query));
}
