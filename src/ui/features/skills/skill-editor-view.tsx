import { Button, Input, TextArea } from "@heroui/react";
import { Modal } from "../../components/modal.js";
import { SettingsSelect } from "../../components/settings/settings-controls.js";
import type { SkillEditorViewModel } from "./use-skill-editor.js";
function fresh(botId: string) {
  return {
    type: "skill.save" as const,
    id: crypto.randomUUID(),
    botId,
    revision: 0,
    name: "",
    description: "",
    body: "",
  };
}
export function SkillEditorView({
  bots,
  onClose,
  draft,
  setDraft,
  pending,
  error,
  setError,
  busy,
  query,
  setQuery,
  blocked,
  lastSaved,
  persist,
  change,
  load,
  submit,
  recover,
  visible,
}: SkillEditorViewModel) {
  const editor = (
    <form
      className="skill-form"
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
        )
          event.preventDefault();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {
        <>
          <label>
            所属 Bot
            <SettingsSelect
              label="技能所属 Bot"
              value={draft.botId}
              disabled={blocked || busy || !!pending || draft.revision > 0}
              onChange={(value) => change({ botId: value })}
              options={bots.map((b) => ({ value: b.id, label: b.name }))}
            />
          </label>
        </>
      }
      <label>
        名称
        <Input
          variant="secondary"
          fullWidth
          aria-label="技能名称"
          required
          maxLength={80}
          value={draft.name}
          disabled={blocked || busy || !!pending}
          onChange={(e) => change({ name: e.target.value })}
        />
      </label>
      <label>
        何时使用
        <Input
          variant="secondary"
          fullWidth
          aria-label="技能描述"
          required
          maxLength={500}
          value={draft.description}
          disabled={blocked || busy || !!pending}
          onChange={(e) => change({ description: e.target.value })}
        />
      </label>
      <label>
        步骤
        <TextArea
          variant="secondary"
          fullWidth
          aria-label="技能正文"
          required
          maxLength={32000}
          value={draft.body}
          disabled={blocked || busy || !!pending}
          onChange={(e) => change({ body: e.target.value })}
        />
      </label>
      {
        <p className="muted">
          {draft.revision
            ? `当前编辑 v${draft.revision}，保存会生成新版本。`
            : "保存后可在输入框键入 / 引用。"}
        </p>
      }
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {blocked && (
        <Button
          type="button"
          variant="secondary"
          className="secondary"
          isDisabled={busy}
          onPress={() => void recover()}
        >
          保留异常草稿并重新读取
        </Button>
      )}
      <div className="skill-actions">
        <Button
          variant="primary"
          className="primary"
          isDisabled={
            blocked ||
            busy ||
            (!pending &&
              (!draft.name.trim() ||
                !draft.description.trim() ||
                !draft.body.trim()))
          }
        >
          {busy ? "保存中…" : pending ? "重试原请求" : "保存技能"}
        </Button>
        {draft.revision > 0 && (
          <Button
            type="button"
            variant="secondary"
            className="secondary"
            isDisabled={blocked || busy || !!pending}
            onPress={() => {
              void submit(true);
            }}
          >
            删除技能
          </Button>
        )}
      </div>
    </form>
  );
  return (
    <Modal title="技能" wide onClose={onClose}>
      <div className="skill-manager">
        <div className="skill-list">
          <Input
            variant="secondary"
            fullWidth
            aria-label="搜索技能"
            placeholder="搜索技能"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button
            variant="secondary"
            className="secondary"
            isDisabled={blocked || busy || !!pending}
            onPress={() => {
              const next = fresh(draft.botId);
              if (persist(next, null, null)) {
                lastSaved.current = null;
                setDraft(next);
                setError("");
              }
            }}
          >
            创建技能
          </Button>
          {visible.map((s) => (
            <Button
              key={s.id}
              variant="ghost"
              className={s.id === draft.id ? "selected" : ""}
              isDisabled={blocked || busy || !!pending}
              onPress={() => {
                void load(s);
              }}
            >
              <strong>{s.name}</strong>
              <span>
                v{s.revision} · {s.description}
              </span>
            </Button>
          ))}
          {!visible.length && <p className="muted">暂无技能</p>}
        </div>
        {editor}
      </div>
    </Modal>
  );
}
