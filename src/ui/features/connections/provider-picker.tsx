import { Button } from "@heroui/react";
import { SettingsSearch } from "../../components/settings/settings-controls.js";
import { useState } from "react";
import { Icon } from "../../components/icons.js";
import { providerPresets, type ProviderPreset } from "./provider-presets.js";

export function ProviderPicker({
  onSelect,
}: {
  onSelect(preset: ProviderPreset | null): void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const search = query.trim().toLocaleLowerCase();
  const matches = providerPresets.filter((preset) =>
    `${preset.name} ${preset.id} ${preset.description}`
      .toLocaleLowerCase()
      .includes(search),
  );
  const groups = ["全部", "模型厂商", "第三方平台", "本地模型"];
  const visible = matches.filter(
    (preset) => category === "全部" || preset.group === category,
  );
  return (
    <div className="provider-picker">
      <SettingsSearch
        label="搜索供应商"
        placeholder="搜索供应商名称或网址"
        value={query}
        onChange={setQuery}
        className="settings-provider-search"
      />
      <div className="provider-picker-body">
        <nav className="provider-categories" aria-label="供应商分类">
          {groups.map((group) => (
            <Button
              variant={category === group ? "tertiary" : "ghost"}
              key={group}
              type="button"
              aria-pressed={category === group}
              onPress={() => setCategory(group)}
            >
              {group}
              <span>
                {
                  matches.filter(
                    (preset) => group === "全部" || preset.group === group,
                  ).length
                }
              </span>
            </Button>
          ))}
        </nav>
        <div className="provider-options">
          <Button
            variant="outline"
            type="button"
            className="provider-custom"
            onPress={() => onSelect(null)}
          >
            <span className="provider-mark">
              <Icon name="settings" size={19} />
            </span>
            <span>
              <strong>自定义配置</strong>
              <small>手动填写请求地址和模型接口</small>
            </span>
            <Icon name="chevron" size={15} />
          </Button>
          {groups
            .slice(1)
            .filter((group) => visible.some((preset) => preset.group === group))
            .map((group) => (
              <section key={group}>
                <h3>{group}</h3>
                <div className="provider-grid">
                  {visible
                    .filter((preset) => preset.group === group)
                    .map((preset) => (
                      <Button
                        variant="outline"
                        type="button"
                        className="provider-option"
                        key={preset.id}
                        onPress={() => onSelect(preset)}
                      >
                        <span
                          className="provider-mark"
                          data-provider={preset.id}
                        >
                          {preset.name.slice(0, 1)}
                        </span>
                        <span>
                          <strong>{preset.name}</strong>
                          <small>{preset.description}</small>
                        </span>
                      </Button>
                    ))}
                </div>
              </section>
            ))}
          {visible.length === 0 && (
            <p className="provider-no-results">
              没有匹配的供应商，可以使用自定义配置。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
