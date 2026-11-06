import { Button, Input, TextArea } from "@heroui/react";
import { useId, useLayoutEffect } from "react";
import { Avatar } from "../../components/icons.js";
import { Modal } from "../../components/modal.js";
import { errorMessage } from "../../lib/client.js";
import { BotModelChoice } from "./bot-model.js";
import type { BotCreationModel } from "./use-bot-creation.js";

export function BotCreateDialog({
  model,
  onClose,
}: {
  model: BotCreationModel;
  onClose(): void;
}) {
  const dialogId = useId();
  useLayoutEffect(() => {
    document.getElementById(dialogId)?.focus({ preventScroll: true });
  }, [dialogId]);
  const {
    name,
    setName,
    description,
    setDescription,
    busy,
    setBusy,
    error,
    setError,
    createDraft,
    createNotice,
    create,
  } = model;
  return (
    <Modal
      id={dialogId}
      title="创建新 Bot"
      busy={busy}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="create-form create-bot-form"
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          const connectionId = new FormData(e.currentTarget).get(
            "connectionId",
          );
          setBusy(true);
          void create(
            name,
            description,
            typeof connectionId === "string" ? connectionId : "",
          )
            .catch((err) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        <Avatar />
        <label>
          名称
          <Input
            variant="secondary"
            fullWidth
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          说明
          <TextArea
            variant="secondary"
            fullWidth
            maxLength={4000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="告诉 Bot 它的职责、语气和偏好"
          />
        </label>
        <div className="create-machine-fields">
          <BotModelChoice
            disabled={busy}
            initialConnection={createDraft?.connectionId ?? ""}
          />
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="create-actions">
          {createNotice && !error && (
            <p role="status" className="create-pending">
              {createNotice}
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            className="primary"
            isDisabled={busy || !name.trim()}
          >
            {busy ? "正在确认…" : createNotice ? "查看创建结果" : "创建 Bot"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
