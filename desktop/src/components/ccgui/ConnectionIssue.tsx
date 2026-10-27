import { Icon } from "../ui/icon";

export function ConnectionIssue({ errors, stderr, unavailable, retrying, onRetry, onSettings, onDismiss }: {
  errors: string[]; stderr: string[]; unavailable?: boolean; retrying?: boolean;
  onRetry?: () => void; onSettings?: () => void; onDismiss: () => void;
}) {
  if (!errors.length && !stderr.length) return null;
  // Group presentation only: retain every diagnostic detail instead of dropping a second source.
  const details = [...new Set([...errors, ...stderr])].join("\n");
  const auth = /permission denied|authentication failed|认证失败/i.test(details);
  const title = auth ? "身份验证失败" : unavailable ? "当前环境暂不可用" : "本次操作未完成";
  return <section className="cc-connection-issue" aria-label={title}>
    <div className="cc-connection-issue-title"><Icon name="alertTriangle" size={16} /><strong>{title}</strong><button className="cc-chat-icon" type="button" onClick={onDismiss} aria-label="关闭错误提示"><Icon name="close" size={14} /></button></div>
    <p>{auth ? "请检查连接凭据或密钥。" : unavailable ? "请检查连接和 Claude Code 是否可用。" : "展开详情查看原因，再决定如何继续。"}你的对话和草稿已保留。</p>
    <div className="cc-connection-issue-actions">
      {unavailable && onRetry && <button type="button" disabled={retrying} onClick={onRetry}>{retrying ? "正在检查…" : "重新检查环境"}</button>}
      {unavailable && onSettings && <button type="button" onClick={onSettings}>检查连接配置</button>}
      <details><summary>查看详情</summary><pre>{details}</pre></details>
    </div>
  </section>;
}
