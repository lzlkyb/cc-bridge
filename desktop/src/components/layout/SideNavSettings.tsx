import { useRef, useState } from "react";
import { Icon } from "../ui/icon";
import type { SettingsSection } from "../../lib/settingsSections";
import { searchSettings, stepSettingsSection } from "../../lib/settingsNavigation";
import { CATEGORY_DESCRIPTIONS } from "../../lib/settingsCategories";
import { Modal } from "../ui/Modal";
import { useSettingsMenuMotion } from "../../hooks/useSettingsMenuMotion";
import "../../settings-motion.css";

const summaries: Record<string, string> = {
  "set-app": "外观、启动与资源", "set-terminal": "配色、字体与操作", "set-network": "端口、HTTPS 与防火墙",
  "set-files": "编码与命令行为", "set-mcpbridge": "服务与工具范围", "set-data": "备份、审计与迁移", "set-notify": "命令与任务完成提醒",
};

/** 设置目录支持滚轮逐项切换，溢出列表优先保留原生滚动。 */
export function SideNavSettings({ sections, activeId, onSelect, onBack, collapsed, platform }: {
  sections: SettingsSection[]; activeId: string; onSelect: (id: string, anchor?: string) => void;
  onBack: () => void; collapsed: boolean; platform?: string;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const selectionPlate = useSettingsMenuMotion(navRef, activeId, query, collapsed);
  const wheel = useRef({ accumulated: 0, lastEvent: -Infinity, lastSwitch: -Infinity });
  const results = searchSettings(query, sections.map(s => s.id), platform);
  const selectResult = (sectionId: string, anchor?: string) => {
    setQuery(""); setSearchOpen(false); onSelect(sectionId, anchor);
  };
  const handleNavWheel = (e: React.WheelEvent<HTMLElement>) => {
    const state = wheel.current;
    if (query.trim() || searchOpen || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.deltaX !== 0 || Math.abs(e.deltaY) < 1) {
      state.accumulated = 0;
      return;
    }
    const nav = e.currentTarget;
    const now = performance.now();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? nav.clientHeight || 800 : 1);
    if (now - state.lastEvent > 200 || Math.sign(delta) !== Math.sign(state.accumulated)) state.accumulated = 0;
    state.lastEvent = now;
    // 矮窗口先让用户滚完目录；到边缘再切分类，不抢列表自身的滚动。
    const canScroll = delta > 0 ? nav.scrollTop + nav.clientHeight < nav.scrollHeight - 1 : nav.scrollTop > 0;
    if (canScroll) { state.accumulated = 0; return; }
    // 一格滚轮即可切换，小幅输入累计；冷却避免一次甩动跳过多个菜单。
    if (now - state.lastSwitch < 350) return;
    state.accumulated += delta;
    if (Math.abs(state.accumulated) < 60) return;
    const next = stepSettingsSection(sections, activeId, state.accumulated > 0 ? 1 : -1);
    state.accumulated = 0;
    state.lastSwitch = now;
    if (next) onSelect(next.id);
  };
  return <>
    <button type="button" className="app-side-item app-side-back" title={collapsed ? "返回工作区" : undefined} onClick={onBack}>
      <Icon name="arrowLeft" size={16} className="app-side-icon" /><span className="app-side-label">返回工作区</span>
    </button>
    {collapsed ? <button type="button" className="app-side-item" title="搜索具体设置" aria-label="搜索具体设置" onClick={() => setSearchOpen(true)}><Icon name="search" size={16} /></button> :
      <div className="app-side-search"><Icon name="search" size={13} className="app-side-search-icon" />
        <input type="search" value={query} placeholder="搜索设置…" aria-label="搜索设置" onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Escape") setQuery(""); }} />
      </div>}
    <nav ref={navRef} className="app-side-nav settings-side-nav" aria-label="设置目录" onWheel={handleNavWheel}>
      <div ref={selectionPlate} className="settings-selection-plate" aria-hidden="true" hidden />
      {query.trim() ? <>
        <p className="app-side-cluster-title">{results.length} 个设置结果</p>
        {results.map(item => <button key={item.id} type="button" className="app-side-item" onClick={() => selectResult(item.sectionId!, item.anchor)}>
          <Icon name={item.icon} size={16} className="app-side-icon" /><span className="app-side-label"><span>{item.label}</span><small>{item.group}</small></span>
        </button>)}
        {!results.length && <div className="app-side-empty">没有匹配的设置，试试“字号”或“GBK”。</div>}
      </> : sections.map((section, index) => <div key={section.id} className={section.id === "set-about" ? "settings-about-link" : undefined}>
        {(index === 2 || section.id === "set-about") && <div className="app-side-cluster-sep" role="presentation" />}
        <button type="button" className="app-side-item" data-active={section.id === activeId || undefined} aria-current={section.id === activeId ? "page" : undefined}
          title={collapsed ? section.label : CATEGORY_DESCRIPTIONS[section.id]} onClick={() => onSelect(section.id)}>
          <Icon name={section.icon} size={16} className="app-side-icon" /><span className="app-side-label"><span>{section.label}</span>{summaries[section.id] && <small>{summaries[section.id]}</small>}</span>
        </button>
      </div>)}
    </nav>
    <Modal open={searchOpen} onClose={() => { setSearchOpen(false); setQuery(""); }} className="modal-surface w-full max-w-lg rounded-xl p-5">
      <h2 className="mb-3 text-sm font-semibold">搜索设置</h2>
      <input autoFocus className="input h-9 w-full rounded-md border bg-background px-3 text-sm" aria-label="搜索具体设置" placeholder="字号、证书、GBK、备份…" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="mt-3 max-h-80 overflow-y-auto">{results.map(item => <button key={item.id} type="button" className="flex w-full items-center justify-between gap-3 rounded-md p-3 text-left text-sm hover:bg-muted" onClick={() => selectResult(item.sectionId!, item.anchor)}><span>{item.label}</span><span className="text-xs text-muted-foreground">{item.group}</span></button>)}
        {!query.trim() && <p className="py-3 text-xs text-muted-foreground">输入名称或关键词，直接定位对应控件。</p>}
        {query.trim() && !results.length && <p className="py-3 text-xs text-muted-foreground">没有匹配结果，请调整关键词。</p>}
      </div>
      <button type="button" className="mt-3 text-xs text-muted-foreground" onClick={() => { setSearchOpen(false); setQuery(""); }}>关闭</button>
    </Modal>
  </>;
}
