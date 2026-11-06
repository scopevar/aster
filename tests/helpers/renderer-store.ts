import { envelopeSchema } from "../../src/shared/commands.js";
import type { Store } from "../../src/storage/store.js";
import type { WorkerSignal } from "../../src/shared/worker-events.js";
import type { Handlers } from "./renderer-main.js";

/**
 * A signed-in account whose local data is the test's Store, for UI that only
 * renders and edits that data. Cloud, team and device behaviour needs the
 * real worker (`renderer.worker()`).
 */
export function storeHandlers(
  store: () => Store,
  signal: (signal: WorkerSignal) => Promise<void>,
): Handlers {
  return {
    localWorkspace: () => ({
      ready: true,
      directory: "local",
      sources: [],
      backup: null,
    }),
    workerStatus: () => ({ state: "live", cursor: store().cursor() }),
    snapshot: (query) => {
      const view = store().snapshotSince(query);
      return view
        ? {
            changed: true,
            snapshot: {
              ...view,
              capabilities: { agent: "ready", detail: "", accountType: null },
            },
          }
        : { changed: false, cursor: store().cursor() };
    },
    // Main forwards the envelope; the worker validates it and signals the new cursor.
    command: async (envelope) => {
      const result = store().execute(envelopeSchema.parse(envelope));
      await signal({ state: "live", cursor: store().cursor() });
      return result;
    },
    routines: (query) => ({
      ...store().routineOperations.view(query),
      webhookBase: "http://127.0.0.1:0/webhooks",
      schedulerError: null,
    }),
    // Local execution without model connections, paired machines, human rooms or cloud sync unless a test provides them.
    agentConnections: () => ({
      revision: "0",
      config: { defaultAgent: "", connections: [] },
      path: "agents.json",
      override: null,
      active: "",
      notice: "",
    }),
  };
}
