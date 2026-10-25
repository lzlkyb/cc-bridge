import type { CcRetryInfo } from "../../lib/ccEventTypes";
import { Icon } from "../ui/icon";
import { Notice } from "./Notice";

/**
 * 会话条下面那一叠提示：权限风险 / 重试 / 缓冲溢出 / CLI 错误 / 前端错误。
 *
 * 单独拆出来纯粹是因为 `CcGuiTab` 贴到 300 行的体量门禁了 —— 但这几块本来就
 * 是一个整体：它们**全部**是「不影响继续打字，但用户必须看见」的信息，
 * 顺序由危险程度决定（风险横幅 > 重试 > 缺口 > 报错），改动时应当一起改。
 *
 * 用 `Notice` 而不是 toast：这些内容要能回头看，toast 三秒后就没了。
 */
export function SessionNotices({
  risk,
  conflict,
  retry,
  dropped,
  error,
  stderr,
  compacted,
  background,
  onDismiss,
}: {
  /** `bypassPermissions` 的风险文案。没有就不渲染。 */
  risk: string | undefined;
  /**
   * 同目录下正在跑的另一条会话标题。`null` = 没有冲突。
   *
   * 两个 CC 进程指向同一台机器的同一个目录时会改同一批文件、互相覆盖，
   * 而界面上看不出任何异常 —— 这条提示是唯一的线索。只提示不拦截：
   * 「两个都跑、改不同文件」是正当用法（R17 不做审批门）。
   */
  conflict: string | null;
  retry: CcRetryInfo | null;
  /** 缓冲/裁剪缺口条数。 */
  dropped: number;
  /** 前端侧错误（invoke 失败、探测失败）。 */
  error: string | null;
  /** CLI 的 stderr 尾巴（已截好）。 */
  stderr: string[];
  /** 上下文被压缩后的 token 数。`null` = 这一轮没压缩过。 */
  compacted: number | null;
  /** 正在跑的后台任务数。 */
  background: number;
  onDismiss: () => void;
}) {
  return (
    <>
      {/* 🔴 bypassPermissions 下 can_use_tool 根本不触发，界面会「看起来很安静」——
          这条横幅是唯一能告诉用户「已经没有把关了」的地方，不能省。 */}
      {risk && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-warning/30 bg-warning/[.08] px-3 py-1.5 text-[11px] text-warning-ink">
          <Icon name="alertTriangle" size={11} className="shrink-0" />
          {risk}
        </div>
      )}

      {/* 同目录并发排在权限风险之后：它同样影响「这次发送会改变什么」，
          但不是配置问题，是环境里另有一条会话正在动同样的文件。 */}
      {conflict && (
        <div className="flex shrink-0 items-start gap-1.5 border-b border-warning/30 bg-warning/[.08] px-3 py-1.5 text-[11px] leading-[1.5] text-warning-ink">
          <Icon name="alertTriangle" size={11} className="mt-[2px] shrink-0" />
          <span className="min-w-0 flex-1">
            同一目录下「{conflict}」正在运行 —— 两个进程会改同一批文件，可能互相覆盖。
          </span>
        </div>
      )}

      {retry && (
        <Notice tone="warn">
          重试中 {retry.attempt}/{retry.max} · {retry.message}
        </Notice>
      )}
      {/* 压缩与后台任务都是「CC 自己做的事」：不提示的话用户只看到模型突然
          忘了前面的事、或回答中途凭空多等一分钟，两边都会以为是界面坏了。 */}
      {compacted !== null && (
        <Notice tone="info">上下文已压缩到 {compacted.toLocaleString()} tokens，更早的细节模型不再逐字记得。</Notice>
      )}
      {background > 0 && (
        <Notice tone="info">有 {background} 个后台任务在跑，本轮结束后它还会自己再干一轮。</Notice>
      )}
      {dropped > 0 && (
        <Notice tone="info">更早的 {dropped} 条事件已滚出缓冲，翻不到更上面了。</Notice>
      )}
      {error && (
        <Notice tone="error" onDismiss={onDismiss}>
          {error}
        </Notice>
      )}
      {stderr.length > 0 && (
        <Notice tone="error" onDismiss={onDismiss}>
          <span className="font-mono">{stderr.join(" / ")}</span>
        </Notice>
      )}
    </>
  );
}
