import { useState } from "react";
import { AppearancePreview } from "./AppearancePreview";
import { Icon } from "../../ui/icon";

export function ApplicationSettingsPreview() {
  const [expanded, setExpanded] = useState(false);
  return <aside className="settings-context" data-expanded={expanded || undefined}>
    <h2>外观预览 <span>实时</span><button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Icon name="eye" size={13} />{expanded ? "收起预览" : "展开预览"}</button></h2>
    <div className="application-preview-detail"><AppearancePreview large /><p className="settings-preview-caption">连接页布局示意</p><p>界面风格作用于整个应用。终端保留独立明暗与配色，切换外观不会中断会话。</p></div>
  </aside>;
}
