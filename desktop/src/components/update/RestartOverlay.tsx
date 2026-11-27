import { APP_INFO } from "../../lib/about";

/** Keeps feedback visible while the safety check and native relaunch are pending. */
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
