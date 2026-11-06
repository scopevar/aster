import { useState } from "react";
import type { Attachment } from "../../shared/files/attachments.js";
import type { MemoryScope, SharedMemoryScope } from "../../shared/memory.js";
import type { SkillSummary } from "../../shared/tools/skills.js";
import type { AppModal } from "./app-state.js";
import { type DeletionTarget } from "./deletion.js";
export function useAppOverlays() {
  const [copyBotId, setCopyBotId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeletionTarget | null>(null);
  const [memoryScope, setMemoryScope] = useState<MemoryScope | null>(null);
  const [sharedMemory, setSharedMemory] = useState<SharedMemoryScope | null>(
    null,
  );
  const [skillManager, setSkillManager] = useState(false);
  const [skillPreview, setSkillPreview] = useState<SkillSummary | null>(null);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [modal, setModal] = useState<AppModal>(null);
  const [templateDraftId, setTemplateDraftId] = useState<string | undefined>(
    undefined,
  );
  const [settingsTab, setSettingsTab] = useState("通用");
  return {
    copyBotId,
    setCopyBotId,
    deleteTarget,
    setDeleteTarget,
    memoryScope,
    setMemoryScope,
    sharedMemory,
    setSharedMemory,
    skillManager,
    setSkillManager,
    skillPreview,
    setSkillPreview,
    preview,
    setPreview,
    modal,
    setModal,
    templateDraftId,
    setTemplateDraftId,
    settingsTab,
    setSettingsTab,
  };
}

export type AppOverlayViewModel = ReturnType<typeof useAppOverlays>;
