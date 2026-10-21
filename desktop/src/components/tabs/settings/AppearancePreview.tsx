import { useAppearance } from "../../../hooks/useAppearance";
import { useThemeMode } from "../../../hooks/useThemeMode";
import type { Appearance } from "../../../lib/appearance";
import type { Theme } from "../../../lib/theme";
import { Icon } from "../../ui/icon";

/** A layout specimen, deliberately detached from live service data and commands. */
export function AppearancePreview({ appearance, large = false, theme }: { appearance?: Appearance; theme?: Theme; large?: boolean }) {
  const current = useAppearance();
  const mode = useThemeMode();
  return <div className={`appearance-specimen ${appearance ?? current} ${(theme ?? mode) === "dark" ? "is-dark" : ""} ${large ? "is-large" : ""}`} aria-hidden="true">
    <div className="specimen-sidebar"><i /><span /><span /><span /></div>
    <div className="specimen-work"><div className="specimen-top"><i /><i /><i /></div>
      <div className="specimen-grid"><div className="specimen-service">{large && <><small>服务状态</small><div className="specimen-chain"><Icon name="check" size={12} /><i /><Icon name="check" size={12} /><i /><Icon name="check" size={12} /></div><b>本机服务已就绪</b><span>等待远程接入</span></>}</div>
        <div className="specimen-metric">{large && <><small>请求速率</small><b>—</b></>}</div><div className="specimen-metric">{large && <><small>P95 延迟</small><b>—</b></>}</div><div className="specimen-health">{large && <><small>健康度 · 安全治理</small><span>清楚呈现当前状态</span></>}</div></div>
      <div className="specimen-connect">{large && <><b>接入 Claude Code</b><span>项目级 <Icon name="check" size={10} /></span><i /></>}</div>
    </div>
  </div>;
}
