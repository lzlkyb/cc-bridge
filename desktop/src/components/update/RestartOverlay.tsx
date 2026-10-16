import { APP_INFO } from "../../lib/about";

/**
 * 重启过渡层（方案 C，2026-10-16）。
 *
 * 点「重启」后：界面会闪一下消失 → 1–3 秒空白 → 应用重新出现。这段空白里
 * 用户**无法区分「正在升级」和「崩了」**。用一个 1.1 秒的过渡层把它包住，
 * 升级就成了一件被看见的事 —— 这段刻意的等待本身就是仪式感的载体。
 *
 * 🔴 唯一的真实风险在调用方（UpdateContext.restart）：`relaunch()` 失败时
 *    必须复位 restarting，否则本层会永久盖住界面，用户只能杀进程。
 */
export function RestartOverlay({ current, next }: { current?: string; next?: string }) {
  return (
    <div className="restart-overlay" role="alert" aria-label="正在应用更新，应用将自动重启">
      <img className="ro-logo" src="/icon.png" alt="" width={58} height={58} draggable={false} />
      <div className="ro-title">正在应用更新</div>
      {current && next && (
        <div className="ro-ver">
          <span>v{current}</span>
          <i>→</i>
          <b>v{next}</b>
        </div>
      )}
      <div className="ro-bar">
        <i />
      </div>
      <div className="ro-hint">{APP_INFO.name} 将自动重启，请稍候</div>
    </div>
  );
}
