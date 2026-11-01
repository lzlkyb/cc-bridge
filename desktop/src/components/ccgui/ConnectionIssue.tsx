import { Icon } from "../ui/icon";

/**
 * 会话顶部那块错误横幅：**两个来源分开呈现**。
 *
 * 2026-11 审查（P3-2 / P3-3）改了两件事：
 *
 * 1. **前端错误按条渲染 + 每条自己的 ×**。此前只有一个「关闭全部」的 ×，
 *    而 `ccReducer` 与 `useCcSession` 早就提供了逐条关闭的 `dismissError(index)`，
 *    注释也写着「每条一个 ×」—— 三处说法互相矛盾，`capErrors` 的「保头 + 最新」
 *    设计意图（根因不能被后续噪音挤掉）也落不了地。现在点掉一条就只关那一条。
 * 2. **CLI 输出（stderr）与界面错误分段展示、各自保留原始顺序**。此前用
 *    `new Set([...errors, ...stderr])` 合并去重：用户分不清哪句是 CLI 报的、
 *    哪句是界面报的，而且 `Set` 会把 CLI 合法的重复行（构建工具的重复警告很常见）
 *    一并吞掉 —— `ccReducer` 那边专门为此写了「只对相邻批次去重」的逻辑，到这里
 *    被一个全局去重抹平了。
 *
 * 「身份验证失败」这类标题仍然按两段合起来的文本判断：那是同一套环境诊断，
 * 从哪条通道来的都一样。
 */
export function ConnectionIssue({
  errors,
  stderr,
  unavailable,
  retrying,
  onRetry,
  onSettings,
  onDismissError,
  onDismissStderr,
}: {
  errors: string[];
  stderr: string[];
  unavailable?: boolean;
  retrying?: boolean;
  onRetry?: () => void;
  onSettings?: () => void;
  /** 关掉第 `index` 条界面错误。 */
  onDismissError: (index: number) => void;
  /** 清空 CLI 输出（一个整体：它是同一个进程的流水）。 */
  onDismissStderr: () => void;
}) {
  if (!errors.length && !stderr.length) return null;
  const auth = /permission denied|authentication failed|认证失败/i.test([...errors, ...stderr].join("\n"));
  const title = auth ? "身份验证失败" : unavailable ? "当前环境暂不可用" : "本次操作未完成";
  return (
    <section className="cc-connection-issue" aria-label={title}>
      <div className="cc-connection-issue-title">
        <Icon name="alertTriangle" size={16} />
        <strong>{title}</strong>
        {stderr.length > 0 && (
          <button className="cc-chat-icon" type="button" onClick={onDismissStderr} aria-label="关闭 Claude Code 输出">
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      <p>
        {auth ? "请检查连接凭据或密钥。" : unavailable ? "请检查连接和 Claude Code 是否可用。" : "展开详情查看原因，再决定如何继续。"}
        你的对话和草稿已保留。
      </p>
      {errors.length > 0 && (
        <ul className="cc-connection-issue-list">
          {errors.map((message, index) => (
            // key 用序号 + 文本：`errors` 是追加式列表，被关掉一条之后索引会整体前移，
            // 用纯序号当 key 会让后面几条跟着换元素（读屏的 aria-live 会重新念一遍）。
            <li key={`${index}:${message}`}>
              <span>{message}</span>
              <button type="button" onClick={() => onDismissError(index)} aria-label="关闭这条错误">
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="cc-connection-issue-actions">
        {unavailable && onRetry && (
          <button type="button" disabled={retrying} onClick={onRetry}>
            {retrying ? "正在检查…" : "重新检查环境"}
          </button>
        )}
        {unavailable && onSettings && (
          <button type="button" onClick={onSettings}>
            检查连接配置
          </button>
        )}
        <details>
          <summary>查看详情</summary>
          {stderr.length > 0 && (
            <div className="cc-connection-issue-group">
              <span>Claude Code 输出</span>
              <pre>{stderr.join("\n")}</pre>
            </div>
          )}
          {errors.length > 0 && (
            <div className="cc-connection-issue-group">
              <span>界面错误</span>
              <pre>{errors.join("\n")}</pre>
            </div>
          )}
        </details>
      </div>
    </section>
  );
}
