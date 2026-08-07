import { Button } from "../../../ui/button";
import { Icon } from "../../../ui/icon";
import { Switch } from "../../../ui/switch";
import { Spinner } from "../../../ui/Spinner";
import { SubSetting } from "../SubSetting";
import { fullCommand, type McpBridgeServer, type ServerState } from "./types";

/** 徽章文案与颜色。全部可由**不启进程**的信息算出来。 */
function badgeOf(s: McpBridgeServer, master: boolean): { text: string; cls: string; dot: string } {
  if (!master && s.enabled) {
    return { text: "已勾选，未生效", cls: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/50" };
  }
  const map: Record<ServerState, { text: string; cls: string; dot: string }> = {
    ready: {
      text: `已就绪 · ${s.toolCount} 个工具`,
      cls: "bg-success/12 text-success",
      dot: "bg-success",
    },
    stale: { text: "需刷新", cls: "bg-warning/14 text-warning", dot: "bg-warning" },
    unknown: { text: "未探测", cls: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/50" },
    not_installed: {
      text: "命令未找到",
      cls: "bg-destructive/12 text-destructive",
      dot: "bg-destructive",
    },
    failed: { text: "连接失败", cls: "bg-destructive/12 text-destructive", dot: "bg-destructive" },
  };
  return map[s.state];
}

function stamp(sec?: number): string | null {
  if (!sec) return null;
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `探测于 ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 单条 server。
 *
 * 🔴 完整命令必须逐字展示（S0）：没有那一行，用户看到的只是个叫 `filesystem`
 * 的名字，根本不知道自己要交出去的是整个 `D:`。但**不高亮其中任何片段**（S5）。
 */
export function ServerRow({
  server,
  master,
  busy,
  onToggle,
  onProbe,
  onEdit,
  onRemove,
  onToggleRemoteCwd,
}: {
  server: McpBridgeServer;
  master: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
  onProbe: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onToggleRemoteCwd: (next: boolean) => void;
}) {
  const b = badgeOf(server, master);
  const when = stamp(server.fetchedAt);

  return (
    <div
      className={`mb-2 rounded-lg border px-3 py-2.5 ${server.enabled && master ? "" : "opacity-75"}`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${b.dot}`} />
        <span className="truncate text-[13px] font-semibold">{server.name}</span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${b.cls}`}>{b.text}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* 总开关关着时禁用：这是本卡里**唯一会真的启动子进程**的按钮。 */}
          <Button
            variant="outline"
            size="sm"
            disabled={!master || busy}
            onClick={onProbe}
            title={master ? "启动它一次、拓下工具清单、再关掉" : "总开关关闭时不允许启动子进程"}
          >
            {busy ? <Spinner size={12} /> : <Icon name="refresh" size={12} />}
            探测
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit} title="编辑启动参数">
            <Icon name="settings" size={12} />
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove} title="删除">
            <Icon name="trash" size={12} />
          </Button>
          <Switch
            checked={server.enabled}
            onChange={onToggle}
            variant="danger"
            ariaLabel={`启用 ${server.name}`}
          />
        </span>
      </div>

      <div className="mt-1.5 break-all rounded-md bg-muted px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed">
        {fullCommand(server.command, server.args)}
      </div>

      <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-[11px] text-muted-foreground">
        <span>工作目录：{server.cwd || `跟随 cc-bridge${server.effectiveCwd ? `（${server.effectiveCwd}）` : ""}`}</span>
        <span>环境变量：{server.envKeys.length ? server.envKeys.join("、") : "无"}</span>
        {server.state === "stale" && <span>命令或参数已变，需重新探测</span>}
        {when && server.state === "ready" && <span>{when}</span>}
        {/* 不显示的话，用户不知道自己开了几个进程——多项目下这个数会涨。 */}
        {server.liveCwds.length > 0 && (
          <span title={server.liveCwds.join(" · ")}>
            运行中：{server.liveCwds.length} 个目录
          </span>
        )}
      </div>

      {/* 🔴 本特性里唯一放宽边界的开关。做成子项：它是这个 server 的参数，
          不是独立开关；server 未启用时跟着置灰。 */}
      <SubSetting disabled={!server.enabled} hint="该 server 未启用，此项暂不生效">
        <div className="flex items-start gap-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium">允许远程指定工作目录</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              让远程按项目切——每个目录会各起一个进程。只能选白名单根目录内的位置。
            </div>
            {server.allowRemoteCwd && (
              <div className="mt-1 text-[11px] text-destructive">
                ⚠ 白名单<b>只限它从哪里启动，不限它启动后能碰什么</b>。
              </div>
            )}
          </div>
          <Switch
            checked={server.allowRemoteCwd}
            onChange={onToggleRemoteCwd}
            variant="danger"
            ariaLabel={`允许远程为 ${server.name} 指定工作目录`}
          />
        </div>
      </SubSetting>

      {/* 错误原文就地展，不只弹 toast——toast 一闪就没了，而这里的错误往往得照着改命令。 */}
      {server.error && (
        <div className="mt-1.5 whitespace-pre-wrap break-all rounded-md bg-destructive/10 px-2.5 py-1.5 font-mono text-[11px] text-destructive">
          {server.error}
        </div>
      )}
    </div>
  );
}
