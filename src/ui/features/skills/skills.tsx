import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useEffect, useState } from "react";
import type { CommandResult } from "../../../shared/core.js";
import { type Bot } from "../../../shared/chat/bots.js";
import {
  skillSchema,
  type Skill,
  type SkillSummary,
} from "../../../shared/tools/skills.js";
import { desktop, errorMessage } from "../../lib/client.js";
import { Modal } from "../../components/modal.js";
import { SkillEditorView } from "./skill-editor-view.js";
import { useSkillEditor } from "./use-skill-editor.js";

export function SkillPreview({
  skill,
  onClose,
}: {
  skill: SkillSummary;
  onClose(): void;
}) {
  const [content, setContent] = useState<Skill | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    void desktop
      .skillContent({
        id: skill.id,
        botId: skill.botId,
        revision: skill.revision,
      })
      .then((raw) => {
        const data = skillSchema.parse(raw);
        if (!disposed) setContent(data);
      })
      .catch((e) => {
        if (!disposed) setError(errorMessage(e));
      });
    return () => {
      disposed = true;
    };
  }, [skill]);
  return (
    <Modal title={`${skill.name} · v${skill.revision}`} onClose={onClose}>
      <div className="skill-preview">
        <p>{skill.description}</p>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : content ? (
          <pre>{content.body}</pre>
        ) : (
          <p role="status">正在读取技能…</p>
        )}
      </div>
    </Modal>
  );
}

export function SkillManager({
  bots,
  skills,
  act,
  onClose,
  initialDraft,
}: {
  bots: Bot[];
  skills: SkillSummary[];
  act(command: Command, request?: Envelope): Promise<CommandResult | undefined>;
  onClose(): void;
  initialDraft?: {
    id: string;
    body: string;
    name: string;
    description: string;
  };
}) {
  const model = useSkillEditor({
    bots,
    skills,
    act,
    onClose,
    ...(initialDraft !== undefined ? { initialDraft } : {}),
  });
  return <SkillEditorView {...model} />;
}
