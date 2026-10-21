import { useId, useState, useMemo, useEffect } from "react";
import { invoke } from "../../lib/tauri";
import type { StaticStatus } from "../../lib/types";
import { McpScope, buildTokenSedCommand } from "../../lib/utils";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { InlineNotice } from "../ui/notice";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { SavedHint } from "../ui/SavedHint";

/**
 * 令牌操作常驻，内容默认掩码；重生成继续保留确认与远程修复命令。
 */
export function TokenManager({
  status,
  onRefresh,
  projectPath,
}: {
  status?: StaticStatus;
  onRefresh: () => void;
  projectPath: string;
}) {
  const [showToken, setShowToken] = useState(false);
  const [confirmingRegen, setConfirmingRegen] = useState(false);
  const [regenDone, setRegenDone] = useState(false);
  const [oldToken, setOldToken] = useState("");
  /**
   * 重生成**返回值**（审查 B10）。
   *
   * 后端 `regenerate_token` 直接返回新 token，但原实现把它丢了、改用
   * `status.token`；而 `onRefresh()` 是异步的，命令在 refetch 落地前就按
   * **旧值**算好了 → 界面上是一条 `s#Bearer old#Bearer old#g` 的空操作，
   * 复制到远端执行完照样 401，用户却以为已经换好了。
   */
  const [newToken, setNewToken] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const { toast } = useToast();
  // 复制反馈统一走 useCopyFeedback（评审修复 ⑤）：原先的 SavedHint 无 toast 方案收敛进来，
  // 反馈时长与其余复制点一致（2s），失败有 toast 兜底。
  const fb = useCopyFeedback();
  const tokenBody = useAutoAnimateRM<HTMLDivElement>();
  const headingId = useId();

  // 原地替换 Bearer，不 remove+add（保留服务器条目与授权状态，避免重新授权）。
  // 作用域读持久化的 status.scope（当初接入确认的作用域），而非 UI 开关，避免匹配错文件。
  // 🔴 新 token 优先用重生成的**返回值**（B10）：refetch 未落地时 status.token 还是旧值，
  // 用它会把命令算成空操作。
  const currentToken = newToken || (status?.token ?? "");
  // 返回值只用于等待刷新；后端令牌变化后应跟随最新配置，避免一直显示旧的临时值。
  useEffect(() => { setNewToken(""); }, [status?.token]);
  const tokenSedCommand = useMemo(
    () => buildTokenSedCommand(oldToken, currentToken, (status?.scope ?? "user") as McpScope, projectPath),
    [oldToken, currentToken, status?.scope, projectPath],
  );

  const handleRegenToken = async () => {
    const old = currentToken;
    // 生成中态：避免用户连点两次（第二次会把第一次的新 token 又换掉，
    // 而界面上的命令只对得上其中一次）。
    setRegenerating(true);
    try {
      const next = await invoke<string>("regenerate_token");
      setOldToken(old);
      setNewToken(next);
      onRefresh();
      setConfirmingRegen(false);
      setRegenDone(true);
      setShowToken(false);
      toast("Token 已重新生成，请复制新连接命令到远程服务器", "warning");
    } catch (e) {
      // 失败必须可见：静默失败时用户会以为 token 已换、去远端执行一条不存在的命令。
      toast(`Token 重生成失败：${e}`, "error");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <section className="connect-token" aria-labelledby={headingId}>
      <div className="connect-section-heading"><h3 id={headingId}>访问令牌</h3></div>
      <p className="connect-support-desc">{currentToken ? "已配置 · 默认隐藏令牌内容" : "正在加载令牌…"}</p>

      <div ref={tokenBody}>
          <div className="connect-token-actions flex items-center gap-3">
            <div className="flex flex-1 items-center gap-2 min-w-0">
              <code className={`flex-1 min-w-0 rounded-md px-3 py-2 text-xs font-mono ${showToken && !regenerating ? "bg-background border" : "bg-muted/60"}`}>
                {regenerating
                  ? "生成中…"
                  : showToken
                    ? currentToken
                    : "●●●●●●●●●●●●●●●●●●●●"}
              </code>
              <Button type="button" variant="ghost" size="sm" disabled={regenerating || !currentToken} onClick={() => setShowToken(!showToken)}>
                <Icon name={showToken ? "eyeOff" : "eye"} size={14} />
                {showToken ? "隐藏" : "显示"}
              </Button>
            </div>
            <div className="shrink-0">
              {!confirmingRegen ? (
                <Button type="button" variant="outline" size="sm" disabled={!currentToken} onClick={() => setConfirmingRegen(true)}>
                  <Icon name="refresh" size={14} />
                  重生成
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>请确认…</Button>
              )}
            </div>
          </div>

          {regenDone && (
            <InlineNotice variant="warning">
              <div className="space-y-2">
                <p>Token 已更新。请复制下方命令到远程服务器执行，原地替换 Bearer（不重新授权）：</p>
                <div className="flex flex-wrap gap-2 items-start">
                  <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md bg-background border px-3 py-2 text-xs font-mono leading-relaxed">
                    {tokenSedCommand || "加载中..."}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 mt-0.5"
                    onClick={() => {
                      if (tokenSedCommand) fb.copy("sed", tokenSedCommand);
                    }}
                    disabled={!tokenSedCommand}
                    aria-live="polite"
                  >
                    {fb.isCopied("sed") ? <SavedHint>已复制</SavedHint> : "复制"}
                  </Button>
                </div>
              </div>
            </InlineNotice>
          )}

          {confirmingRegen && (
            <InlineNotice variant="error">
              <div className="flex flex-wrap items-center justify-between gap-3">
                {/* 多设备模式（opt-in）开启时提及跨设备影响；关闭时维持既有文案（兼容性契约）。 */}
                <span className="flex-1">
                  旧 Token 将立即失效，远程 AI 工具会断开连接
                  {status?.multiDeviceMode ? "；若另一台电脑也接入了，那台机器的连接会一并断开" : ""}
                  。确定？
                </span>
                <span className="flex gap-2 shrink-0">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleRegenToken}
                    disabled={regenerating}
                  >
                    {regenerating ? "生成中…" : "确定"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmingRegen(false)}
                    disabled={regenerating}
                  >
                    取消
                  </Button>
                </span>
              </div>
            </InlineNotice>
          )}
      </div>
    </section>
  );
}
