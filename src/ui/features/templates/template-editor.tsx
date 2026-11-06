import { Disclosure } from "../../components/disclosure.js";
import { Button, Input, TextArea } from "@heroui/react";
import { routineScheduleText } from "../../../presentation/routine-schedule.js";
import type { TemplatePayload } from "../../../shared/templates/templates.js";
import { TemplateCover } from "./template-cover.js";
import { SettingsSelect } from "../../components/settings/settings-controls.js";

export function TemplateEditor({
  value,
  onChange,
  disabled,
}: {
  value: TemplatePayload;
  onChange(value: TemplatePayload): void;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="template-editor">
      <label>
        模板名称
        <Input
          variant="secondary"
          fullWidth
          maxLength={80}
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </label>
      <label>
        模板说明
        <TextArea
          variant="secondary"
          fullWidth
          aria-label="模板说明"
          maxLength={4000}
          value={value.description}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
        />
      </label>
      <label>
        模板标签
        <Input
          variant="secondary"
          fullWidth
          maxLength={240}
          value={value.tags}
          onChange={(e) => onChange({ ...value, tags: e.target.value })}
        />
      </label>
      <label>
        模板语言
        <SettingsSelect
          label="模板语言"
          value={value.language}
          onChange={(selection) => {
            if (
              selection === "auto" ||
              selection === "zh-CN" ||
              selection === "en" ||
              selection === "ja"
            )
              onChange({ ...value, language: selection });
          }}
          options={[
            { value: "auto", label: "自动" },
            { value: "zh-CN", label: "简体中文" },
            { value: "en", label: "English" },
            { value: "ja", label: "日本語" },
          ]}
        />
      </label>
      {value.avatar.image && (
        <div>
          <img
            className="template-cover"
            alt="模板头像"
            src={`data:image/webp;base64,${value.avatar.image}`}
          />
          <Button
            variant="secondary"
            className="secondary"
            onPress={() =>
              onChange({ ...value, avatar: { ...value.avatar, image: null } })
            }
          >
            移除模板头像
          </Button>
        </div>
      )}
      <TemplateCover
        disabled={disabled}
        onChange={(image) =>
          onChange({ ...value, avatar: { ...value.avatar, image } })
        }
      />
      <h3>技能 · {value.skills.length}</h3>
      {value.skills.map((skill, index) => (
        <Disclosure key={index} title={<>{skill.name || "未命名技能"}</>}>
          <label>
            技能名称
            <Input
              variant="secondary"
              fullWidth
              value={skill.name}
              maxLength={80}
              onChange={(e) =>
                onChange({
                  ...value,
                  skills: value.skills.map((item, i) =>
                    i === index ? { ...item, name: e.target.value } : item,
                  ),
                })
              }
            />
          </label>
          <label>
            技能说明
            <Input
              variant="secondary"
              fullWidth
              value={skill.description}
              maxLength={500}
              onChange={(e) =>
                onChange({
                  ...value,
                  skills: value.skills.map((item, i) =>
                    i === index
                      ? { ...item, description: e.target.value }
                      : item,
                  ),
                })
              }
            />
          </label>
          <label>
            技能正文
            <TextArea
              variant="secondary"
              fullWidth
              aria-label="技能正文"
              value={skill.body}
              maxLength={32000}
              onChange={(e) =>
                onChange({
                  ...value,
                  skills: value.skills.map((item, i) =>
                    i === index ? { ...item, body: e.target.value } : item,
                  ),
                })
              }
            />
          </label>
          <Button
            variant="secondary"
            className="secondary"
            onPress={() =>
              onChange({
                ...value,
                skills: value.skills.filter((_, i) => i !== index),
              })
            }
          >
            移除此技能
          </Button>
        </Disclosure>
      ))}
      <Button
        variant="secondary"
        className="secondary"
        isDisabled={value.skills.length >= 100}
        onPress={() =>
          onChange({
            ...value,
            skills: [
              ...value.skills,
              { name: "新技能", description: "", body: "" },
            ],
          })
        }
      >
        添加模板技能
      </Button>
      <h3>例行任务 · {value.routines.length}</h3>
      <p>导入后全部暂停，Webhook 不携带密钥。</p>
      {value.routines.map((routine, index) => (
        <Disclosure key={index} title={<>{routine.name}</>}>
          <label>
            任务名称
            <Input
              variant="secondary"
              fullWidth
              value={routine.name}
              maxLength={80}
              onChange={(e) =>
                onChange({
                  ...value,
                  routines: value.routines.map((item, i) =>
                    i === index ? { ...item, name: e.target.value } : item,
                  ),
                })
              }
            />
          </label>
          <label>
            任务指令
            <TextArea
              variant="secondary"
              fullWidth
              aria-label="任务指令"
              value={routine.prompt}
              maxLength={16000}
              onChange={(e) =>
                onChange({
                  ...value,
                  routines: value.routines.map((item, i) =>
                    i === index ? { ...item, prompt: e.target.value } : item,
                  ),
                })
              }
            />
          </label>
          {routine.schedule.kind === "cron" ? (
            <>
              <label>
                计划
                <Input
                  variant="secondary"
                  fullWidth
                  value={routine.schedule.expression}
                  maxLength={120}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      routines: value.routines.map((item, i) =>
                        i === index && item.schedule.kind === "cron"
                          ? {
                              ...item,
                              schedule: {
                                ...item.schedule,
                                expression: e.target.value,
                              },
                            }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <label>
                时区
                <Input
                  variant="secondary"
                  fullWidth
                  value={routine.schedule.timeZone}
                  maxLength={100}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      routines: value.routines.map((item, i) =>
                        i === index && item.schedule.kind === "cron"
                          ? {
                              ...item,
                              schedule: {
                                ...item.schedule,
                                timeZone: e.target.value,
                              },
                            }
                          : item,
                      ),
                    })
                  }
                />
              </label>
            </>
          ) : (
            <p>{routineScheduleText(routine.schedule)}</p>
          )}
          <Button
            variant="secondary"
            className="secondary"
            onPress={() =>
              onChange({
                ...value,
                routines: value.routines.filter((_, i) => i !== index),
              })
            }
          >
            移除此任务
          </Button>
        </Disclosure>
      ))}
    </fieldset>
  );
}
