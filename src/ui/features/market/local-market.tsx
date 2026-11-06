import { Button, Tabs } from "@heroui/react";
import { useState } from "react";
import type { Snapshot } from "../../../shared/snapshot.js";
import type { SkillSummary } from "../../../shared/tools/skills.js";
import { Modal } from "../../components/modal.js";
import { Icon } from "../../components/icons.js";
import {
  SettingsSearch,
  SettingsSelect,
} from "../../components/settings/settings-controls.js";
import { PluginManager } from "../plugins/plugin-manager.js";
import { LocalPluginSkills } from "../plugins/local-plugin-skills.js";
import { Templates } from "../templates/templates.js";
import { LocalMarketBots } from "./local-market-bots.js";
import { LocalMarketTemplates } from "./local-market-templates.js";
import { LocalMarketEmpty } from "./local-market-empty.js";
import "./local-market.css";

export function LocalMarket({
  state,
  activeBotId,
  onClose,
  onNewBot,
  onOpenBot,
  onConversation,
  onChanged,
  onSkill,
}: {
  state: Snapshot;
  activeBotId?: string;
  onClose(): void;
  onNewBot(): void;
  onOpenBot(id: string): void;
  onConversation(id: string): void;
  onChanged(): void;
  onSkill(skill: SkillSummary): void;
}) {
  const bots = state.bots.filter((bot) => bot.lifecycle === "active");
  const [tab, setTab] = useState("bots");
  const [query, setQuery] = useState("");
  const [botId, setBotId] = useState(activeBotId ?? bots[0]?.id ?? "");
  const bot = bots.find((item) => item.id === botId) ?? bots[0];
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  return (
    <>
      <Modal title="本地市场" variant="market" onClose={onClose}>
        <div className="local-market">
          <div className="local-market-heading">
            <div>
              <h3>你的本地内容</h3>
              <p>浏览 Bot、安装插件，用模板文件分享配置。</p>
            </div>
          </div>
          <Tabs
            className="local-market-tabs"
            selectedKey={tab}
            onSelectionChange={(key) => {
              setTab(String(key));
              setQuery("");
            }}
          >
            <div className="local-market-toolbar">
              <Tabs.ListContainer className="local-market-categories">
                <Tabs.List aria-label="本地内容分类">
                  <Tabs.Tab id="bots">
                    <Icon name="bot" size={16} />
                    <span>Bot</span>
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  <Tabs.Tab id="plugins">
                    <Icon name="skill" size={16} />
                    <span>插件</span>
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  <Tabs.Tab id="templates">
                    <Icon name="book" size={16} />
                    <span>模板</span>
                    <Tabs.Indicator />
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.ListContainer>
              <SettingsSearch
                className="local-market-search"
                label="搜索本地内容"
                placeholder="搜索名称或说明"
                value={query}
                onChange={setQuery}
              />
            </div>
            <Tabs.Panel id="bots" className="local-market-panel">
              <div className="local-market-section-heading">
                <h3>
                  你的 Bot <span>{bots.length}</span>
                </h3>
                {bots.length > 0 && (
                  <Button variant="primary" size="sm" onPress={onNewBot}>
                    <Icon name="plus" size={16} />
                    新建 Bot
                  </Button>
                )}
              </div>
              <LocalMarketBots
                bots={bots}
                query={query}
                onOpen={onOpenBot}
                onNew={onNewBot}
              />
            </Tabs.Panel>
            <Tabs.Panel id="plugins" className="local-market-panel">
              {bot ? (
                <>
                  <PluginManager
                    key={bot.id}
                    botId={bot.id}
                    query={query}
                    onChanged={onChanged}
                    target={
                      <div className="local-market-plugin-target">
                        <span>安装到 Bot</span>
                        <SettingsSelect
                          label="安装到 Bot"
                          value={bot.id}
                          options={bots.map((item) => ({
                            value: item.id,
                            label: item.name,
                          }))}
                          onChange={setBotId}
                        />
                      </div>
                    }
                  />
                  <LocalPluginSkills
                    skills={state.skills.filter(
                      (skill) =>
                        skill.botId === bot.id &&
                        [skill.name, skill.description].some((text) =>
                          text
                            .toLocaleLowerCase()
                            .includes(query.trim().toLocaleLowerCase()),
                        ),
                    )}
                    onOpen={onSkill}
                  />
                </>
              ) : (
                <LocalMarketEmpty icon="skill" title="先创建 Bot，再导入插件。">
                  <p>插件安装到你选择的 Bot，工具权限逐项确认。</p>
                  <Button variant="primary" size="sm" onPress={onNewBot}>
                    新建 Bot
                  </Button>
                </LocalMarketEmpty>
              )}
            </Tabs.Panel>
            <Tabs.Panel id="templates" className="local-market-panel">
              <div className="local-market-section-heading">
                <h3>本地模板</h3>
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() => setTemplateId("")}
                >
                  管理本地模板
                </Button>
              </div>
              <LocalMarketTemplates
                query={query}
                revision={revision}
                onEdit={setTemplateId}
              />
            </Tabs.Panel>
          </Tabs>
        </div>
        {templateId !== null && (
          <Templates
            {...(bot ? { bot } : {})}
            {...(templateId ? { initialDraftId: templateId } : {})}
            onClose={() => {
              setTemplateId(null);
              setRevision(revision + 1);
            }}
            onConversation={onConversation}
          />
        )}
      </Modal>
    </>
  );
}
