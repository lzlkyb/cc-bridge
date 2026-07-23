import { useState, useEffect, type ReactNode } from "react";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, ConfigSaveResult } from "../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ToggleRow } from "../ui/ToggleRow";
import { useToast } from "../ui/toast";
import { ConfirmModal } from "../ui/ConfirmModal";
import { Spinner } from "../ui/Spinner";
import { buildBaseCommand } from "../../lib/utils";

/**
 * 设置页「功能开关」卡。
 * 按「安全 / 数据保护 / 兼容与性能」三组呈现（fix #4），卡顶带风险总览（fix #10）。
 * 普通开关保存后即时反馈「已保存 ✓」（fix #2）；关闭白名单 / 开启命令执行为高风险，需二次确认。
 *
 * highlightAnchor：由 Header 安全徽章点击带入（{ anchor, nonce }）。
 * 切换到本页后自动滚动到对应 ToggleRow 并脉冲高亮 2 秒，引导用户定位开关。
 */
export function SettingsToggles({
  status,
  onSaved,
  highlightAnchor,
}: {
  status?: StatusResponse;
  onSaved: () => void;
  highlightAnchor?: { anchor: string; nonce: number } | null;
}) {
  const [confirmWhitelistOff, setConfirmWhitelistOff] = useState(false);
  const [confirmShellOn, setConfirmShellOn] = useState(false);
  const [ackShellRisk, setAckShellRisk] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [refreshingBash, setRefreshingBash] = useState(false);
  const [confirmSse, setConfirmSse] = useState(false);
  const { toast } = useToast();

  // 由 Header 安全徽章点击触发的定位 + 高亮。
  // 非激活 Tab 在 Tabs 中为 return null（完全卸载），切到设置页时本组件才挂载，
  // 此时 highlightAnchor 已就绪，挂载即定位，无需额外延时。
  useEffect(() => {
    if (!highlightAnchor?.anchor) return;
    const el = document.getElementById(`toggle-${highlightAnchor.anchor}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("anchor-highlight");
    const t = setTimeout(() => el.classList.remove("anchor-highlight"), 2000);
    return () => clearTimeout(t);
  }, [highlightAnchor]);

  // 保存并给出「已保存 ✓」反馈（fix #2）。key 用于定位反馈落在哪一行。
  const save = async (patch: Record<string, unknown>, key?: string) => {
    try {
      await invoke<ConfigSaveResult>("save_config", { patch });
      onSaved();
      if (key) {
        setSavedKey(key);
        setTimeout(() => setSavedKey((cur) => (cur === key ? null : cur)), 1500);
      }
    } catch (e) {
      // 之前无 try/catch，保存失败会静默抛未处理 rejection，开关看似生效实则未落盘。
      toast(`保存失败：${e}`, "error");
    }
  };

  const handleResetDefaults = async () => {
    try {
      await invoke<ConfigSaveResult>("save_config", {
        patch: {
          whitelistEnabled: true,
          readonlyMode: false,
          auditEnabled: true,
          backupEnabled: true,
          rateLimitEnabled: true,
          encodingDetectEnabled: false,
          shellEnabled: false,
        },
      });
      setConfirmReset(false);
      onSaved();
    } catch (e) {
      toast(`恢复默认失败：${e}`, "error");
    }
  };

  const handleWhitelist = (next: boolean) => {
    // 打开直接保存；关闭需二次确认（放开对整机文件的保护）。
    if (next) {
      save({ whitelistEnabled: true }, "whitelist");
    } else {
      setConfirmWhitelistOff(true);
    }
  };

  const handleShell = (next: boolean) => {
    // 开启命令执行等同于授予 RCE，需二次确认；关闭无需确认。
    if (next) {
      setConfirmShellOn(true);
    } else {
      save({ shellEnabled: false }, "shell");
    }
  };

  const readonly = status?.readonlyMode ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle icon={<Icon name="sliders" />}>功能开关</CardTitle>
      </CardHeader>
      <CardContent className="space-y-0">
        {/* 风险总览（fix #10） */}
        <RiskSummary status={status} />

        {/* ── 分组：安全 ── */}
        <GroupTitle>安全</GroupTitle>
        <ToggleRow
          id="toggle-whitelist"
          label="路径白名单校验"
          danger={status ? !status.whitelistEnabled : false}
          sub={
            status && !status.whitelistEnabled
              ? "⚠ 已关闭 · 远程可访问本机全部文件，仅剩 Token 保护"
              : "仅允许访问白名单根目录内的文件（强烈建议保持开启）"
          }
          checked={status?.whitelistEnabled ?? true}
          onChange={handleWhitelist}
          saved={savedKey === "whitelist"}
        />
        <ToggleRow
          id="toggle-readonly"
          label="只读模式"
          sub="开启后禁止写入 / 删除 / 移动 / 复制，仅允许读取、列目录、搜索"
          checked={readonly}
          onChange={(v) => save({ readonlyMode: v }, "readonly")}
          saved={savedKey === "readonly"}
        />
        <ToggleRow
          id="toggle-shell"
          label="命令执行"
          danger={status?.shellEnabled ?? false}
          sub={
            readonly
              ? "当前只读模式已开启，命令执行将被强制禁止；如需启用请先关闭只读模式"
              : status?.shellEnabled
                ? "⚠ 已开启 · 等同于授予远程任意代码执行权限（RCE）"
                : "允许远程执行 Shell 命令（run_command）。默认关闭，强烈建议仅临时开启"
          }
          checked={status?.shellEnabled ?? false}
          variant="danger"
          onChange={handleShell}
          saved={savedKey === "shell"}
          last
        />

        {/* ── 分组：数据保护 ── */}
        <GroupTitle>数据保护</GroupTitle>
        <ToggleRow
          label="审计日志"
          sub="记录每次工具调用到日志页；关闭后停止记录"
          checked={status?.auditEnabled ?? true}
          onChange={(v) => save({ auditEnabled: v }, "audit")}
          saved={savedKey === "audit"}
        />
        <ToggleRow
          label="写操作自动备份"
          sub="写入 / 删除前先备份到备份目录；关闭可节省磁盘"
          checked={status?.backupEnabled ?? true}
          onChange={(v) => save({ backupEnabled: v }, "backup")}
          saved={savedKey === "backup"}
          last
        />

        {/* ── 分组：兼容与性能 ── */}
        <GroupTitle>兼容与性能</GroupTitle>
        <ToggleRow
          label="限流保护"
          sub="按窗口限制请求次数，防止异常高频调用"
          checked={status?.rateLimitEnabled ?? true}
          onChange={(v) => save({ rateLimitEnabled: v }, "ratelimit")}
          saved={savedKey === "ratelimit"}
        />
        <ToggleRow
          label="读取编码自适应"
          sub="开启：自动识别 GBK/GB18030（适合 NC65 等旧系统源码）；关闭：固定按 UTF-8 读取，避免误判。显式指定编码不受影响"
          checked={status?.encodingDetectEnabled ?? false}
          onChange={(v) => save({ encodingDetectEnabled: v }, "encoding")}
          saved={savedKey === "encoding"}
        />
        <ToggleRow
          id="toggle-session-persist"
          label="命令会话持久化"
          sub="开启后 run_command 可用 session_id 跨调用保留工作目录，并通过 env 参数（key=value）持久化环境变量（如 venv / PATH），解决 source venv / export 每调用丢失的问题。默认关闭"
          checked={status?.sessionCwdEnabled ?? false}
          onChange={(v) => save({ sessionCwdEnabled: v }, "session-persist")}
          saved={savedKey === "session-persist"}
        />
        {/* 命令执行壳层：cmd / bash 分段选择（shell_type UI 开关）。
         * bashAvailable=false（未检测到 Git for Windows）时 bash 置灰、显示「刷新检测」按钮。 */}
        <ShellTypeRow
          value={status?.shellType ?? "cmd"}
          bashAvailable={status?.bashAvailable ?? true}
          onSelect={(v) => save({ shellType: v }, "shelltype")}
          onBashUnavailable={() =>
            toast("未检测到 Git for Windows，bash 不可用，已保持 cmd", "warning")
          }
          onRefreshBash={async () => {
            setRefreshingBash(true);
            try {
              const found = await invoke<boolean>("refresh_bash_detection");
              if (found) {
                toast("已检测到 Git Bash，现在可以切换到 bash 了", "success");
              } else {
                toast("仍未检测到 Git for Windows，请确认已安装", "warning");
              }
            } catch {
              toast("检测失败，请稍后重试", "error");
            } finally {
              setRefreshingBash(false);
              onSaved(); // 触发 get_status 刷新 bashAvailable
            }
          }}
          refreshingBash={refreshingBash}
          saved={savedKey === "shelltype"}
        />
        <TransportRow
          value={status?.transport ?? "http"}
          onSelect={(v) => {
            if (v === "sse") {
              setConfirmSse(true);
            } else {
              save({ transport: "http" }, "transport");
            }
          }}
          saved={savedKey === "transport"}
          last
        />
      </CardContent>

      {confirmWhitelistOff && (
        <WhitelistOffModal
          onCancel={() => setConfirmWhitelistOff(false)}
          onConfirm={() => {
            save({ whitelistEnabled: false }, "whitelist");
            setConfirmWhitelistOff(false);
          }}
        />
      )}
      {confirmShellOn && (
        <ShellRiskModal
          readonly={readonly}
          ackRisk={ackShellRisk}
          onAckChange={setAckShellRisk}
          onCancel={() => {
            setConfirmShellOn(false);
            setAckShellRisk(false);
          }}
          onConfirm={() => {
            save({ shellEnabled: true }, "shell");
            setConfirmShellOn(false);
            setAckShellRisk(false);
          }}
        />
      )}
      {confirmReset && (
        <ResetModal
          onCancel={() => setConfirmReset(false)}
          onConfirm={handleResetDefaults}
        />
      )}

      {confirmSse && (
        <SseMigrationModal
          status={status}
          onCancel={() => setConfirmSse(false)}
          onConfirm={() => {
            save({ transport: "sse" }, "transport");
            setConfirmSse(false);
            toast("已切换到 SSE，请到远端执行迁移命令", "success");
          }}
        />
      )}

      {/* 重置功能开关（fix #5：改名明确范围 + 去掉 muted 弱化） */}
      <div className="border-t px-5 py-3">
        <Button variant="outline" size="sm" onClick={() => setConfirmReset(true)}>
          <Icon name="refresh" size={13} />
          重置功能开关为默认
        </Button>
      </div>
    </Card>
  );
}

/* 分组小标题（fix #4） */
function GroupTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:mt-1">
      {children}
    </div>
  );
}

/* 命令执行壳层分段选择：cmd（默认）/ bash（Git Bash）。
 * 复用 ToggleRow 行布局（左标签+描述，右控件），控件为两按钮分段器而非开关。
 * bashAvailable=false 时 bash 按钮置灰（aria-disabled + 弱化样式），点击不触发保存，
 * 改为调用 onBashUnavailable（弹 toast 提示先安装 Git for Windows），保持 shell_type 为 cmd。
 * bashAvailable=false 时还会显示「刷新检测」按钮，安装 Git for Windows 后点击即重新探测。 */
function ShellTypeRow({
  value,
  bashAvailable = true,
  onSelect,
  onBashUnavailable,
  onRefreshBash,
  refreshingBash = false,
  saved,
  last = false,
}: {
  value: string;
  bashAvailable?: boolean;
  onSelect: (next: "cmd" | "bash") => void;
  onBashUnavailable?: () => void;
  onRefreshBash?: () => void;
  refreshingBash?: boolean;
  saved?: boolean;
  last?: boolean;
}) {
  const options: { key: "cmd" | "bash"; label: string }[] = [
    { key: "cmd", label: "cmd" },
    { key: "bash", label: "bash" },
  ];
  return (
    <div
      className={`flex items-center justify-between gap-4 py-3.5 ${
        last ? "" : "border-b"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">命令执行壳层</span>
          {saved && <span className="text-xs font-normal text-success">已保存 ✓</span>}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          默认 <b>cmd</b>（零依赖）；选 <b>bash</b> 走 Git Bash，支持 POSIX 语法 / jq / find / 管道。需本机已装 Git for Windows；切换即时生效，无需重启。
        </div>
        {!bashAvailable && (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-xs text-warning">
              ⚠ 未检测到 Git for Windows，bash 暂不可用
            </span>
            {onRefreshBash && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                onClick={onRefreshBash}
                disabled={refreshingBash}
              >
                {refreshingBash ? (
                  <>
                    <Spinner size={10} />
                    检测中…
                  </>
                ) : (
                  <>
                    <Icon name="refresh" size={11} />
                    刷新检测
                  </>
                )}
              </button>
            )}
            <span className="text-[11px] text-muted-foreground/60">安装后点击即生效，无需重启</span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 rounded-lg border bg-muted p-0.5">
        {options.map((o) => {
          const active = value === o.key;
          const disabled = o.key === "bash" && !bashAvailable;
          return (
            <button
              key={o.key}
              type="button"
              aria-disabled={disabled}
              onClick={() => {
                if (disabled) {
                  onBashUnavailable?.();
                  return;
                }
                onSelect(o.key);
              }}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              } ${disabled ? "cursor-not-allowed opacity-40 hover:text-muted-foreground" : ""}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* 风险总览（fix #10）：根据白名单 / 命令执行状态给出安全 or 风险摘要 */
function RiskSummary({ status }: { status?: StatusResponse }) {
  if (!status) return null;
  const risks: string[] = [];
  if (!status.whitelistEnabled) risks.push("白名单已关闭");
  if (status.shellEnabled) risks.push("命令执行已开启");
  const safe = risks.length === 0;
  return (
    <div
      className={`mb-1 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium ${
        safe
          ? "border-success/30 bg-success/10 text-success"
          : "border-destructive/30 bg-destructive/10 text-destructive"
      }`}
    >
      <Icon name={safe ? "check" : "alertTriangle"} size={14} />
      {safe ? "所有安全开关处于推荐状态" : `当前风险：${risks.join(" · ")}`}
    </div>
  );
}

function WhitelistOffModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmModal open onClose={onCancel}>
      <h4 className="mb-2 flex items-center gap-2 text-base font-semibold text-destructive">
        <Icon name="alertTriangle" size={18} />
        确定关闭路径白名单？
      </h4>
      <p className="mb-4 text-sm text-muted-foreground">
        关闭后远程 Claude Code 可读写本机<b>全部文件</b>，风险显著上升。
        请确认你正处于完全可信的网络环境，用完及时开回。
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="destructive" size="sm" onClick={onConfirm}>
          确定关闭
        </Button>
      </div>
    </ConfirmModal>
  );
}

function ShellRiskModal({
  readonly,
  ackRisk,
  onAckChange,
  onCancel,
  onConfirm,
}: {
  readonly: boolean;
  ackRisk: boolean;
  onAckChange: (next: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmModal open onClose={onCancel}>
      <h4 className="mb-2 flex items-center gap-2 text-base font-semibold text-destructive">
        <Icon name="alertTriangle" size={18} />
        确定开启命令执行？
      </h4>
      {/* fix #3：只读模式与命令执行互斥的主动提示 */}
      {readonly && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <Icon name="lock" size={14} className="mt-0.5 shrink-0" />
          <span>
            当前<b>只读模式已开启</b>，命令执行会被<b>强制禁止</b>而不会生效。如需真正启用，请先在上方关闭只读模式。
          </span>
        </div>
      )}
      <p className="mb-3 text-sm text-muted-foreground">
        开启后远程 Claude Code 可在白名单目录内执行<b>任意 Shell 命令</b>，包括但不限于安装软件、
        修改系统设置、访问网络。这等同于授予<b>远程任意代码执行权限（RCE）</b>。
      </p>
      <ul className="mb-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>路径白名单 / 扩展名限制等约束可被命令绕过</li>
        <li>Bearer token 鉴权 + 限流是唯一准入防线</li>
        <li>每条命令都会被强制记入审计日志</li>
      </ul>
      <label className="mb-4 flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={ackRisk}
          onChange={(e) => onAckChange(e.target.checked)}
        />
        我已知晓风险，仅在完全可信的网络环境中开启
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="destructive" size="sm" disabled={!ackRisk} onClick={onConfirm}>
          确定开启
        </Button>
      </div>
    </ConfirmModal>
  );
}

function ResetModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmModal open onClose={onCancel} maxWidth="sm">
      <h4 className="mb-2 flex items-center gap-2 text-base font-semibold">
        <Icon name="alertTriangle" size={18} className="text-warning" />
        重置功能开关为默认？
      </h4>
      <p className="mb-4 text-sm text-muted-foreground">
        这将把白名单校验、审计日志、备份、限流重新开启，只读模式、编码自适应、命令执行关闭。
        当前的白名单目录、扩展名等其他设置不会受影响。
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="default" size="sm" onClick={onConfirm}>
          重置为默认
        </Button>
      </div>
    </ConfirmModal>
  );
}

function TransportRow({
  value,
  onSelect,
  saved,
  last = false,
}: {
  value: string;
  onSelect: (next: "http" | "sse") => void;
  saved?: boolean;
  last?: boolean;
}) {
  const options: { key: "http" | "sse"; label: string }[] = [
    { key: "http", label: "HTTP" },
    { key: "sse", label: "SSE" },
  ];
  return (
    <div
      className={`flex items-center justify-between gap-4 py-3.5 ${
        last ? "" : "border-b"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">MCP 传输协议</span>
          {saved && <span className="text-xs font-normal text-success">已保存 ✓</span>}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          默认 <b>HTTP</b>（JSON-RPC，稳定兼容）；选 <b>SSE</b> 后 run_command 输出实时推送。
          切换后需到远端替换连接命令。
        </div>
      </div>
      <div className="flex shrink-0 rounded-lg border bg-muted p-0.5">
        {options.map((o) => {
          const active = value === o.key;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => onSelect(o.key)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SseMigrationModal({
  status,
  onCancel,
  onConfirm,
}: {
  status?: StatusResponse;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { toast } = useToast();
  const host = status?.host ?? "0.0.0.0";
  const port = status?.port ?? 7823;
  const token = status?.token ?? "";
  const sseCmd = buildBaseCommand(host, port, token, "sse");
  const migrationCmd = `claude mcp remove cc-bridge && ${sseCmd}`;

  const copyMigration = async () => {
    try {
      await navigator.clipboard.writeText(migrationCmd);
      toast("已复制，请到远端终端粘贴执行", "success");
    } catch {
      toast("复制失败，请手动复制", "warning");
    }
  };

  return (
    <ConfirmModal open onClose={onCancel}>
      <h4 className="mb-2 flex items-center gap-2 text-base font-semibold">
        <Icon name="alertCircle" size={18} className="text-primary" />
        切换到 SSE（流式传输）
      </h4>
      <p className="mb-3 text-sm text-muted-foreground">
        切换后 run_command 输出会实时推送到远端。请先复制下方命令到远端终端执行，再点「确认切换」。
      </p>
      <div className="relative mb-2">
        <pre className="rounded-md bg-slate-900 px-3 py-2.5 text-[11px] leading-relaxed text-slate-200 overflow-x-auto whitespace-pre-wrap break-all">
{migrationCmd}
        </pre>
        <button
          type="button"
          className="absolute right-2 top-2 rounded px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700 transition-colors"
          onClick={copyMigration}
        >
          📋 复制
        </button>
      </div>
      <p className="mb-4 text-[11px] text-muted-foreground">
        💡 如果之前用了 <code>--scope project</code>，请在 remove 命令后也加上
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="default" size="sm" onClick={onConfirm}>
          我已复制，确认切换
        </Button>
      </div>
    </ConfirmModal>
  );
}
