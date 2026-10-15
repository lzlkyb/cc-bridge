import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { groupSettingsSections, type SettingsSection } from "../../lib/settingsSections";
import { searchSettings } from "../../lib/settingsNavigation";
import { Modal } from "../ui/Modal";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";

/**
 * 侧栏「设置目录」模式（2026-10-15，方案 B：设计稿 settings-mode 的外壳目录化）。
 *
 * 进入设置页时主侧栏由工作区导航整体切换为本目录：返回工作区 + 搜索过滤 +
 * 簇分组导航（复用 lib/settingsSections 唯一真源，簇切换基于过滤后列表，
 * 与被撤掉的内容区 SettingsNav 同一套纯函数）。
 *
 * 与旧 SettingsNav 的差异：这里是侧栏第一公民（.app-side-item 同款视觉语言），
 * 不再是内容区里的 172px 嵌套导航；搜索是**就地过滤**目录而非打开命令面板
 * （命令面板索引仍在，Ctrl+K 入口不变）。
 *
 * 纯展示组件：高亮 id 由 App 层持有（SettingsTab scrollspy 上报），点击只负责
 * 回报选择意图；滚动定位由 SettingsTab 的 highlightAnchor 效应执行。
 */
export function SideNavSettings({
  sections,
  activeId,
  onSelect,
  onBack,
  collapsed,
}: {
  /** 已按平台过滤的目录项（防火墙卡仅 Windows）。 */
  sections: SettingsSection[];
  activeId: string;
  onSelect: (id: string, anchor?: string) => void;
  /** 返回工作区（App 决定回到哪个 tab——通常是离开设置前的那个）。 */
  onBack: () => void;
  collapsed: boolean;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const reduced = usePrefersReducedMotion();
  const results = searchSettings(query, sections.map(s => s.id));
  useEffect(() => {
    // 内容滚到下面的分类时，目录自身也要露出当前项，避免高亮落在可视区外。
    navRef.current?.querySelector<HTMLElement>('[aria-current="location"]')?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [activeId, query, collapsed, reduced]);

  // 搜索过滤：按标签子串匹配（大小写不敏感）。切簇必须基于过滤后的列表算——
  // groupSettingsSections 对「中间项被拿掉」的情形会重新切簇/定位细线（有单测）。
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter((s) => s.label.toLowerCase().includes(q));
  }, [sections, query]);
  const groups = useMemo(() => groupSettingsSections(filtered), [filtered]);

  return (
    <>
      {/* 返回工作区：目录模式的第一项，视觉弱于导航项（ghost 按钮） */}
      <button
        type="button"
        className="app-side-item app-side-back"
        title={collapsed ? "返回工作区" : undefined}
        onClick={onBack}
      >
        <Icon name="arrowLeft" size={16} className="app-side-icon" />
        <span className="app-side-label">返回工作区</span>
      </button>

      {/* 搜索过滤（B2）：就地过滤目录；图标栏态隐藏（56px 放不下输入框）。
          Escape 清空并退出，不拦截全局快捷键（全局 handler 对 INPUT 目标本就放行）。 */}
      {collapsed ? (
        <button type="button" className="app-side-item" title="搜索具体设置" aria-label="搜索具体设置" onClick={() => setSearchOpen(true)}><Icon name="search" size={16} /></button>
      ) : (
        <div className="app-side-search">
          <Icon name="search" size={13} className="app-side-search-icon" />
          <input
            type="text"
            value={query}
            placeholder="搜索设置"
            aria-label="搜索设置"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
          />
        </div>
      )}

      <nav ref={navRef} className="app-side-nav" aria-label="设置目录">
        {query.trim() ? results.map(item => (
          <button key={item.id} type="button" className="app-side-item" onClick={() => { setQuery(""); onSelect(item.sectionId!, item.anchor); }} title={item.label}>
            <Icon name={item.icon} size={16} className="app-side-icon" />
            <span className="app-side-label flex flex-col"><span>{item.label}</span><small className="text-xs text-muted-foreground">{item.group}</small></span>
          </button>
        )) : groups.map((group, gi) => (
          <div key={group.items[0].id}>
            {gi > 0 && <div className="app-side-cluster-sep" role="presentation" />}
            {/* 簇标题与旧 SettingsNav 同语义：线管分隔、标题管这一簇是干嘛的。
                无标题簇（关于）不渲染；图标栏态隐藏。 */}
            {group.title && !collapsed && (
              <div className="app-side-cluster-title">{group.title}</div>
            )}
            {group.items.map((s) => (
              <button
                key={s.id}
                type="button"
                className="app-side-item"
                data-active={s.id === activeId || undefined}
                aria-current={s.id === activeId ? "location" : undefined}
                title={collapsed ? s.label : undefined}
                onClick={() => onSelect(s.id)}
              >
                <Icon name={s.icon} size={16} className="app-side-icon" />
                <span className="app-side-label">{s.label}</span>
              </button>
            ))}
          </div>
        ))}
        {query.trim() && results.length === 0 && (
          <div className="app-side-empty">无匹配的设置项</div>
        )}
      </nav>
      <Modal open={searchOpen} onClose={() => setSearchOpen(false)} className="modal-surface w-full max-w-lg rounded-xl p-5">
        <h2 className="mb-3 text-sm font-semibold">搜索设置</h2>
        <input autoFocus className="input h-9 w-full rounded-md border bg-background px-3 text-sm" aria-label="搜索具体设置" placeholder="证书、GBK、备份…" value={query} onChange={e => setQuery(e.target.value)} />
        <div className="mt-3 max-h-80 overflow-y-auto">
          {results.map(item => <button key={item.id} type="button" className="flex w-full items-center justify-between gap-3 rounded-md p-3 text-left text-sm hover:bg-muted" onClick={() => { onSelect(item.sectionId!, item.anchor); setQuery(""); setSearchOpen(false); }}><span>{item.label}</span><span className="text-xs text-muted-foreground">{item.group}</span></button>)}
          {!query.trim() && <p className="py-3 text-xs text-muted-foreground">输入设置名称或关键词定位具体项目。</p>}
          {query.trim() && results.length === 0 && <p className="py-3 text-xs text-muted-foreground">没有匹配结果，请调整关键词。</p>}
        </div>
        <button type="button" className="mt-3 text-xs text-muted-foreground" onClick={() => setSearchOpen(false)}>关闭</button>
      </Modal>
    </>
  );
}
