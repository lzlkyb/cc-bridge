import { useEffect, useState } from "react";
import { Icon } from "../ui/icon";

/** 上次「启动时运行的版本」。刻意不复用 `ccb_changelog_last_seen`（那个记的是
 *  「用户上次浏览更新历史时的版本」）—— 写回它会顺手清掉侧栏的更新未读红点。 */
const LAST_RUN_KEY = "ccbridge_last_run_version";
/** 一次性通知，自动隐去；用户也可手动关掉。 */
const AUTO_HIDE_MS = 9000;

/**
 * 升级后首次启动的欢迎条（方案 D，2026-10-16）。
 *
 * 升级流程原本缺一个「结束」：重启回来就是原来的界面，用户不知道这次升了什么。
 * 本组件在**版本号变化**的那次启动浮出一条一次性提示，把闭环补上。
 *
 * - 只认 `localStorage` 里的「上次见到的版本」，与当前版本不同才显示；
 * - **首次安装不显示**（没有上次记录），避免新用户误以为刚升级过；
 * - 浮层定位（fixed），不占布局 —— 与进度条同一条红线。
 */
export function UpgradeWelcomeBar({
  currentVersion,
  onOpenHistory,
}: {
  currentVersion?: string;
  /** 「查看更新内容」：跳到设置页的更新历史（由 App 层提供导航） */
  onOpenHistory?: () => void;
}) {
  const [fromVersion, setFromVersion] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!currentVersion) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_RUN_KEY);
      localStorage.setItem(LAST_RUN_KEY, currentVersion);
    } catch {
      // 存储不可用（隐私模式等）：静默降级为不显示
      return;
    }
    if (last && last !== currentVersion) setFromVersion(last);
  }, [currentVersion]);

  useEffect(() => {
    if (!fromVersion) return;
    const t = setTimeout(() => setHidden(true), AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [fromVersion]);

  if (!fromVersion || hidden) return null;

  return (
    <div className="upgrade-welcome" role="status">
      <span className="uw-icon">
        <Icon name="sparkles" size={13} />
      </span>
      <span className="uw-text">
        已升级到 <b>v{currentVersion}</b>
        <em>从 v{fromVersion}</em>
      </span>
      {onOpenHistory && (
        <button type="button" className="uw-link" onClick={onOpenHistory}>
          查看更新内容
        </button>
      )}
      <button type="button" className="uw-close" onClick={() => setHidden(true)} aria-label="关闭升级提示">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
