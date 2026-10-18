import { useState, useMemo } from "react";
import { invoke } from "../../lib/tauri";
import type { StaticStatus } from "../../lib/types";
import { McpScope, buildTokenSedCommand } from "../../lib/utils";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { InlineNotice } from "../ui/notice";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { useAutoScrollOnExpand } from "../../hooks/useAutoScrollOnExpand";
import { SavedHint } from "../ui/SavedHint";

/**
 * 访问令牌管理（可折叠）。从 ConnectTab 抽离，收口 Token 相关的 5 个局部状态，
 * 通过 props 接收 status / onRefresh / scope / projectPath，自身不依赖父组件状态，
 * 因此父组件无需透传任何 Token 状态，可直接替换整段 Token 区块。
 */
export function TokenManager({
  status,
  onRefresh,
  projectPath,
  expanded,
  onToggle,
}: {
  status?: StaticStatus;
  onRefresh: () => void;
  projectPath: string;
  expanded: boolean;
  onToggle: () => void;
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
  const showBody = expanded || confirmingRegen || regenDone;
  // 首次渲染不自动滚动（hook 内置挂载守卫），仅后续展开才平滑滚动到块头。
  const btnRef = useAutoScrollOnExpand<HTMLButtonElement>(showBody);

  // 原地替换 Bearer，不 remove+add（保留服务器条目与授权状态，避免重新授权）。
  // 作用域读持久化的 status.scope（当初接入确认的作用域），而非 UI 开关，避免匹配错文件。
  // 🔴 新 token 优先用重生成的**返回值**（B10）：refetch 未落地时 status.token 还是旧值，
  // 用它会把命令算成空操作。
  const currentToken = newToken || (status?.token ?? "");
  const tokenSedCommand = useMemo(
    () => buildTokenSedCommand(oldToken, currentToken, (status?.scope ?? "user") as McpScope, projectPath),
    [oldToken, currentToken, status?.scope, projectPath],
  );

  const handleRegenToken = async () => {
    const old = status?.token ?? "";
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
    <>
      <button
        type="button"
        className="collapsible-head w-full text-left"
        onClick={onToggle}
        aria-expanded={showBody}
        ref={btnRef}
      >
        <span
          className="step-num inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-white bg-gradient-to-br from-[#F59E0B] to-[#D97706] shadow-glow-warning"
          role="img"
          aria-label="访问令牌"
        >
          <Icon name="key" size={14} aria-hidden="true" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-foreground">访问令牌</div>
          <div className="text-xs text-muted-foreground">已配置 · 点击展开管理（显示 / 重生成）</div>
        </div>
        <Icon
          name="chevronDown"
          size={16}
          className={`collapsible-chev ${showBody ? "open" : ""}`}
          aria-hidden="true"
        />
      </button>

      <div ref={tokenBody}>
        {showBody && (
          <div className="collapsible-body pl-9">
          <div className="step-row flex items-center gap-3">
            <div className="flex flex-1 items-center gap-2 min-w-0">
              <span className="shrink-0 text-xs font-semibold text-muted-foreground/50">机密信息</span>
              <code className={`flex-1 min-w-0 rounded-md px-3 py-2 text-xs font-mono ${showToken && !regenerating ? "bg-background border" : "bg-muted/60"}`}>
                {regenerating
                  ? "生成中…"
                  : showToken
                    ? (status?.token ?? "")
                    : "●●●●●●●●●●●●●●●●●●●●"}
              </code>
              <Button variant="ghost" size="sm" onClick={() => setShowToken(!showToken)}>
                <Icon name={showToken ? "eyeOff" : "eye"} size={14} />
                {showToken ? "隐藏" : "显示"}
              </Button>
            </div>
            <div className="shrink-0">
              {!confirmingRegen ? (
                <Button variant="outline" size="sm" onClick={() => setConfirmingRegen(true)}>
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
              <div className="flex items-center justify-between gap-3">
                {/* 多设备模式（opt-in）开启时提及跨设备影响；关闭时维持既有文案（兼容性契约）。 */}
                <span className="flex-1">
                  旧 Token 将立即失效，远程 AI 工具会断开连接
                  {status?.multiDeviceMode ? "；若另一台电脑也接入了，那台机器的连接会一并断开" : ""}
                  。确定？
                </span>
                <span className="flex gap-2 shrink-0">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleRegenToken}
                    disabled={regenerating}
                  >
                    {regenerating ? "生成中…" : "确定"}
                  </Button>
                  <Button
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
      )}
      </div>
    </>
  );
}
