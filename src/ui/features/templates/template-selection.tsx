import { Checkbox } from "../../components/checkbox.js";
import { useState } from "react";
import { Button } from "@heroui/react";
import type { TemplateDraft } from "../../../shared/templates/templates.js";
import { desktop, errorMessage } from "../../lib/client.js";

export function TemplateSelection({
  draft,
  disabled,
}: {
  draft: TemplateDraft;
  disabled: boolean;
}) {
  const [configuration, setConfiguration] = useState(false);
  const [skills, setSkills] = useState<number[]>([]);
  const [routines, setRoutines] = useState<number[]>([]);
  const [plugins, setPlugins] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const toggle = (values: number[], index: number) =>
    values.includes(index)
      ? values.filter((value) => value !== index)
      : [...values, index];
  return (
    <fieldset className="template-editor" disabled={disabled}>
      <legend>选择导出内容</legend>
      <Checkbox
        isSelected={configuration}
        onChange={(selected) => setConfiguration(selected)}
        isDisabled={disabled || busy}
      >
        配置、说明和头像
      </Checkbox>
      {draft.payload.skills.map((skill, index) => (
        <Checkbox
          key={`skill-${index}`}
          isSelected={skills.includes(index)}
          onChange={() => setSkills(toggle(skills, index))}
          isDisabled={disabled || busy}
        >
          技能：{skill.name}
        </Checkbox>
      ))}
      {draft.payload.routines.map((routine, index) => (
        <Checkbox
          key={`routine-${index}`}
          isSelected={routines.includes(index)}
          onChange={() => setRoutines(toggle(routines, index))}
          isDisabled={disabled || busy}
        >
          任务：{routine.name}
        </Checkbox>
      ))}
      {draft.payload.plugins.map((plugin, index) => (
        <Checkbox
          key={`plugin-${index}`}
          isSelected={plugins.includes(index)}
          onChange={() => setPlugins(toggle(plugins, index))}
          isDisabled={disabled || busy}
        >
          插件依赖：{plugin.name} {plugin.version}
        </Checkbox>
      ))}
      <p>
        文件包含模板名称和勾选内容。请先检查正文，移除私密信息和本机路径。插件需接收者自行安装，任务导入后暂停。
      </p>
      <Button
        variant="primary"
        isDisabled={disabled}
        isPending={busy}
        onPress={() => {
          setBusy(true);
          setNotice("");
          void desktop
            .templateFile({
              action: "save",
              id: draft.id,
              revision: draft.revision,
              selection: { configuration, skills, routines, plugins },
            })
            .then((result) => {
              if (!result.cancelled) setNotice("模板文件已导出。");
            })
            .catch((cause: unknown) => setNotice(errorMessage(cause)))
            .finally(() => setBusy(false));
        }}
      >
        导出模板文件
      </Button>
      {notice && <p role="status">{notice}</p>}
    </fieldset>
  );
}
