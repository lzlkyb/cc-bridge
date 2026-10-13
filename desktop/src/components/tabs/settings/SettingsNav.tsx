import { Icon } from "../../ui/icon";
import { groupSettingsSections, type SettingsSection } from "../../../lib/settingsSections";

/**
 * 设置页左侧 sticky 导航（初版：design/设置页左侧导航-视觉语言对齐-方案ABC-设计稿.html；
 * 2026-10-13 信息架构重排：簇标题 + aria-current=location，见
 * design/设置页-信息架构重排-设计稿.html）。
 *
 * 视觉语言刻意对齐顶栏 tab（ui/tabs.tsx）：浅灰容器 + 白卡浮起的激活项，让「当前在哪」
 * 和顶栏 tab 用同一套表达；图标包 22×22 chip，与卡片标题的 .title-chip 同源（accent 底
 * + primary 图标）。相邻 group 之间画 1px 细线做视觉分簇，簇首行渲染 9.5px 簇标题
 * （线管分隔、标题管语义；窄窗横排态由 index.css 的 820px 断点隐藏标题只留 chip）。
 *
 * 纯展示组件：滚动高亮由 SettingsTab 维护（scrollspy），点击只负责滚动定位。
 * 「搜索设置」复用命令面板入口——面板里已有 22 条设置项索引（lib/settingsSearch.ts），
 * 这里只是把入口带到设置页面上，不重复实现搜索。
 */
export function SettingsNav({
  sections,
  activeId,
  onSelect,
  onOpenSearch,
  searchShortcut,
}: {
  sections: SettingsSection[];
  activeId: string;
  /** 点击导航项：滚动到对应卡片。 */
  onSelect: (id: string) => void;
  /** 打开命令面板；未传（理论上不会）则不渲染搜索入口。 */
  onOpenSearch?: () => void;
  /** 快捷键标签（按平台变，Ctrl K / ⌘K）。 */
  searchShortcut?: string;
}) {
  // 切簇逻辑在 lib/settingsSections（纯函数 + 单测覆盖），这里只负责渲染。
  const groups = groupSettingsSections(sections);

  return (
    <nav aria-label="设置导航" className="settings-nav sticky top-2 w-[172px] shrink-0">
      <div className="settings-nav-box rounded-xl bg-secondary p-1.5">
        {groups.map((group, gi) => (
          <div key={group.items[0].id}>
            {/* 簇间细线：mx-2 让线不顶到容器边；my-1 与上下簇等距 */}
            {gi > 0 && <div className="settings-nav-cluster-sep mx-2 my-1 h-px bg-border" />}
            {/* 簇标题（信息架构重排设计稿）：9.5px muted，与细线并用——线管分隔、
                标题管「这一簇是干嘛的」。无标题簇（关于）不渲染；窄窗横排态由
                CSS 隐藏（chip 行自带分隔语义）。 */}
            {group.title && (
              <div className="settings-nav-cluster-title px-2 pb-0.5 pt-1 text-[9.5px] font-bold tracking-wide text-muted-foreground">
                {group.title}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((s) => {
                const active = s.id === activeId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onSelect(s.id)}
                    aria-current={active ? "location" : undefined}
                    className={`settings-nav-item flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                      active
                        ? "settings-nav-item-active bg-card font-semibold text-primary shadow-card"
                        : "text-muted-foreground hover:bg-card/70 hover:text-foreground"
                    }`}
                  >
                    {/* chip 缩到 22px 适配导航尺度（卡片标题的 .title-chip 是 28px） */}
                    <span
                      className={`settings-nav-chip grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md ${
                        active ? "bg-accent text-primary" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      <Icon name={s.icon} size={13} />
                    </span>
                    <span className="truncate">{s.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {onOpenSearch && (
        <button
          type="button"
          onClick={onOpenSearch}
          className="settings-nav-search mt-2 flex w-full items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground hover:shadow-card"
        >
          <Icon name="search" size={12} className="shrink-0" />
          搜索设置
          {searchShortcut && (
            <kbd className="ml-auto rounded bg-muted px-1 py-0.5 font-mono text-[9.5px]">
              {searchShortcut}
            </kbd>
          )}
        </button>
      )}
    </nav>
  );
}
