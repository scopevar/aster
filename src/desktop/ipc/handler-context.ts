import type { DirectoryConsent } from "./directory-consent.js";
import type { BrowserWindow } from "electron";
import type { DesktopDiagnostics } from "../native/diagnostics.js";
import { type CommandResult, type Failure } from "../../shared/core.js";
import { type Envelope } from "../../shared/commands.js";
import {
  type DesktopData,
  type DesktopMethod,
} from "../../shared/ipc-contracts.js";
import type { DesktopAttachments } from "../native/attachments.js";
import type { DesktopDocuments } from "../native/documents.js";
import type { DesktopPreferences } from "../../shared/desktop/preferences.js";
import type { DesktopPreferenceStore } from "../native/preferences.js";
import type { WorkerConnection } from "../worker/worker-connection.js";
import type { WorkerFeed } from "../worker/worker-feed.js";
export type DesktopHandlerRegistrar = <K extends DesktopMethod>(
  method: K,
  run: (...input: unknown[]) => DesktopData<K> | Promise<DesktopData<K>>,
  fallback?: Failure,
) => void;
export type DesktopHandlerContext = {
  quitting: boolean;
  handle: DesktopHandlerRegistrar;
  window: BrowserWindow | null;
  draining: Promise<void> | undefined;
  acceptedCommands: Set<Promise<unknown>>;
  worker: WorkerConnection;
  workerCall: WorkerConnection["call"];
  runCommand(envelope: Envelope): Promise<CommandResult>;
  workerFeed: WorkerFeed;
  preferences: DesktopPreferenceStore;
  onPreferencesSaved?(preferences: DesktopPreferences): void;
  attachments: DesktopAttachments;
  documents: DesktopDocuments;
  diagnostics: DesktopDiagnostics;
  directoryConsent: DirectoryConsent;
};
