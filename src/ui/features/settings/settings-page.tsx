import { Button } from "@heroui/react";
import { SettingsSearch } from "../../components/settings/settings-controls.js";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "../../components/icons.js";
import { SettingsDataProvider } from "./settings-data.js";
import { SettingsSection, type SettingsDetail } from "./settings-section.js";
import "../../components/settings/settings-disclosure.css";

const categories: {
  title: string;
  tabs: { name: string; icon: IconName; keywords: string }[];
}[] = [
  {
    title: "个人设置",
    tabs: [
      {
        name: "通用",
        icon: "settings",
        keywords: "外观 主题 语言 系统 硬件加速 对话 取消 上下文",
      },
      { name: "快捷键", icon: "keyboard", keywords: "组合键 打开窗口" },
      { name: "更新", icon: "download", keywords: "版本 通道 自动更新" },
      {
        name: "应用信息",
        icon: "info",
        keywords: "Aster 关于 版本 版权 第三方许可 开源",
      },
    ],
  },
  {
    title: "工作空间",
    tabs: [
      {
        name: "数据与备份",
        icon: "download",
        keywords: "本地 工作区 迁移 数据 导入 导出 恢复",
      },
      {
        name: "模型与连接",
        icon: "link",
        keywords: "模型 Agent 配置 供应商 连接 认证 群聊 主持人 Jev",
      },
      { name: "共享记忆", icon: "book", keywords: "本地记忆 项目记忆" },
      {
        name: "沙箱",
        icon: "computer",
        keywords: "脚本 资源 DNS 网络 代理 连接诊断",
      },
    ],
  },
];
const descriptions: Record<string, string> = {
  数据与备份: "管理本地工作区、数据库备份与恢复。",
  沙箱: "管理本机脚本环境与网络连接。",
  通用: "按你的习惯调整外观、对话和应用性能。",
  快捷键: "通过键盘快速打开应用。",
  模型与连接: "管理 Pi Agent 使用的模型服务、认证凭据及连接配置。",
  共享记忆: "管理多个 Bot 共用的记忆。",
  更新: "管理应用版本与自动更新。",
  应用信息: "查看应用版本、版权和第三方许可。",
};
export function SettingsPage(props: Parameters<typeof SettingsPageContent>[0]) {
  return (
    <SettingsDataProvider>
      <SettingsPageContent {...props} />
    </SettingsDataProvider>
  );
}

function SettingsPageContent({
  tab,
  onTab,
  onClose,
  detail,
  children,
}: {
  tab: string;
  onTab(value: string): void;
  onClose(): void;
  detail: SettingsDetail | null;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const page = useRef<HTMLDivElement>(null);
  const search = query.trim().toLocaleLowerCase();
  const groups = categories
    .map((group) => ({
      ...group,
      tabs: group.tabs.filter((item) =>
        `${item.name} ${item.keywords}`.toLocaleLowerCase().includes(search),
      ),
    }))
    .filter((group) => group.tabs.length);
  useLayoutEffect(() => {
    page.current?.focus({ preventScroll: true });
  }, []);
  const handleKeyboard = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      document.querySelector("dialog[open]") ||
      document.querySelector('[data-slot="modal-backdrop"]') ||
      document.querySelector(".settings-select-popover") ||
      (event.target instanceof Element && event.target.closest("select:open"))
    )
      return;
    event.preventDefault();
    if (query) setQuery("");
    else onClose();
  });
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => handleKeyboard(event);
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, []);
  return (
    <div
      ref={page}
      className="settings-page"
      role="region"
      aria-label="设置"
      tabIndex={-1}
    >
      <aside className="settings-sidebar" aria-label="设置导航">
        <div className="settings-sidebar-top">
          <span className="drag-region" />
          <Button variant="ghost" className="settings-back" onPress={onClose}>
            <Icon name="chevron" size={14} />
            返回应用
          </Button>
        </div>
        <SettingsSearch
          label="搜索设置分类"
          placeholder="搜索设置…"
          value={query}
          onChange={setQuery}
        />
        <nav className="settings-navigation" aria-label="设置分类">
          {groups.map((group) => (
            <div className="settings-nav-group" key={group.title}>
              <h2>{group.title}</h2>
              {group.tabs.map((item) => (
                <Button
                  variant={tab === item.name ? "tertiary" : "ghost"}
                  key={item.name}
                  className={tab === item.name ? "selected" : ""}
                  aria-current={tab === item.name ? "page" : false}
                  onPress={() => onTab(item.name)}
                >
                  <Icon name={item.icon} size={18} />
                  {item.name}
                </Button>
              ))}
            </div>
          ))}
          {groups.length === 0 && (
            <p className="settings-search-empty" role="status">
              未找到相关设置
            </p>
          )}
        </nav>
      </aside>
      <SettingsSection
        key={tab}
        tab={tab}
        description={descriptions[tab]}
        detail={detail}
      >
        {children}
      </SettingsSection>
    </div>
  );
}
