import type { Result } from "../../src/shared/ipc-contracts.js";
import type { Snapshot, SnapshotUpdate } from "../../src/shared/snapshot.js";

/** e2e 直接调用 `window.aster` 拿到的是 Result；需要数据时在 Node 侧取出，失败直接让用例失败。 */
export function data<T>(result: Result<T>): T {
  if (!result.success)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

/** 不带 since 的读取必然返回完整快照；拿不到就是契约被破坏，让用例失败。 */
export function snapshotOf(result: Result<SnapshotUpdate>): Snapshot {
  const update = data(result);
  if (!update.changed)
    throw new Error("未携带 since 的快照返回了 changed:false");
  return update.snapshot;
}
