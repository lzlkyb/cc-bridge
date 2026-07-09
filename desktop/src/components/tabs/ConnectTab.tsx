import { useState, useEffect } from "react";
import { invoke } from "../../lib/tauri";
import type { StatusResponse } from "../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Icon } from "../ui/icon";
import { Alert, AlertDescription } from "../ui/alert";
import { ConnectHero } from "./ConnectHero";

type McpScope = "global" | "project";

export function ConnectTab({
  status,
  onRefresh,
  selectedIp,
  onSelectIp,
}: {
  status?: StatusResponse;
  onRefresh: () => void;
  selectedIp: string;
  onSelectIp: (ip: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmingRegen, setConfirmingRegen] = useState(false);
  const [regenDone, setRegenDone] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [scope, setScope] = useState<McpScope>("project");
  const lanIps = status?.lanIps ?? [];

  // 监听全网卡时才需要选 IP；host 指定了具体地址就用它
  const listenAll = status?.host === "0.0.0.0";

  useEffect(() => {
    if (!listenAll || lanIps.length === 0) return;
    // 仅在从未选过时默认选第一个（默认路由 IP）。已选但现在不在列表中（地址变化）
    // 不在这里静静换新选中——那正是下方 IpChangedBanner 要提示用户确认的情形。
    if (!selectedIp) {
      onSelectIp(lanIps[0]);
    }
  }, [listenAll, lanIps.join(","), selectedIp]);

  // 前端用 token + port + 选中 IP 重新拼命令，摆脱后端写死的单一 IP
  const displayHost = listenAll
    ? selectedIp || "127.0.0.1"
    : status?.host ?? "";
  const port = status?.port ?? 7823;
  const token = status?.token ?? "";

  const baseCommand = status
    ? `claude mcp add --transport http cc-bridge http://${displayHost}:${port}/mcp --header "Authorization: Bearer ${token}"`
    : "";

  const connectCommand =
    scope === "project"
      ? baseCommand.replace("claude mcp add", "claude mcp add --scope project")
      : baseCommand;

  const healthCheck = status
    ? `curl http://${displayHost}:${port}/health`
    : "";

  const handleCopy = () => {
    if (!connectCommand) return;
    navigator.clipboard.writeText(connectCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRegenToken = async () => {
    await invoke("regenerate_token");
    onRefresh();
    setConfirmingRegen(false);
    setRegenDone(true);
    setShowToken(false);
  };

  return (
    <div className="space-y-4">
      {/* IP 变化醒目提示：上次确认的 IP 不在本机网卡列表中了（VPN 重连等），引导用户选新地址 */}
      {status?.ipChanged && (
        <IpChangedBanner
          lanIps={lanIps}
          previousIp={status.lastSelectedIp ?? null}
          port={status.port}
          token={status.token}
          onResolved={onSelectIp}
        />
      )}

      {/* A. Hero 渐变头卡：运行状态 + 地址 + 关键指标 + 启停按钮 */}
      <ConnectHero
        status={status}
        displayHost={displayHost}
        port={port}
        onChanged={onRefresh}
      />

      {/* Connect guide（主卡）*/}
      <Card className="card-primary">
        <CardHeader>
          <CardTitle icon={<Icon name="plug" />}>接入 Claude Code</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* IP 选择器：多网卡时让用户选连接用哪个地址 */}
          {listenAll && lanIps.length > 0 && (
            <AddressPicker
              ips={lanIps}
              selected={selectedIp}
              onSelect={onSelectIp}
              healthCheck={healthCheck}
            />
          )}

          {/* Scope selector as two option cards（默认项目级，选中态强化）*/}
          <div className="grid grid-cols-2 gap-3">
            <OptionCard
              selected={scope === "project"}
              title="项目级"
              desc="仅指定项目生效，按需添加"
              badge="推荐"
              onClick={() => setScope("project")}
            />
            <OptionCard
              selected={scope === "global"}
              title="全局模式"
              desc="一次配置，所有项目都能使用"
              onClick={() => setScope("global")}
            />
          </div>

          {/* Step-by-step guide */}
          <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
            {scope === "global" ? (
              <GlobalSteps
                command={connectCommand}
                copied={copied}
                onCopy={handleCopy}
              />
            ) : (
              <ProjectSteps
                command={connectCommand}
                copied={copied}
                onCopy={handleCopy}
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* Token */}
      <Card>
        <CardHeader>
          <CardTitle icon={<Icon name="key" />}>Token</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md bg-muted px-3 py-2 text-xs font-mono">
              {showToken ? (status?.token ?? "") : "●●●●●●●●●●●●●●●●●●●●"}
            </code>
            <Button variant="ghost" size="sm" onClick={() => setShowToken(!showToken)}>
              <Icon name={showToken ? "eyeOff" : "eye"} size={14} />
              {showToken ? "隐藏" : "显示"}
            </Button>
          </div>

          {regenDone && (
            <Alert variant="warning">
              <AlertDescription className="space-y-2">
                <p>Token 已更新。请复制新的连接命令，到远程服务器重新执行以恢复连接。</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (connectCommand) {
                      navigator.clipboard.writeText(connectCommand);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }
                  }}
                >
                  {copied ? "已复制新命令 ✓" : "复制新连接命令"}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {!confirmingRegen ? (
            <Button variant="outline" size="sm" onClick={() => setConfirmingRegen(true)}>
              <Icon name="refresh" size={14} />
              重新生成 Token
            </Button>
          ) : (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>旧 Token 将立即失效，远程 Claude Code 会断开连接。确定？</span>
                <span className="flex gap-2 shrink-0">
                  <Button variant="destructive" size="sm" onClick={handleRegenToken}>确定</Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmingRegen(false)}>取消</Button>
                </span>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── Step components ─── */

function StepNumber({ n }: { n: number }) {
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
      {n}
    </span>
  );
}

/* ─── 连接地址选择器 ─── */

function ipHint(ip: string): string {
  if (ip.startsWith("192.168.")) return "家用/办公内网";
  if (ip.startsWith("10.")) return "VPN 或企业内网";
  if (ip.startsWith("172.")) return "内网 / VPN / 容器网段";
  return "其它网段";
}

/** 变更醒目 banner：仅 status.ipChanged 为真时渲染。确认选中新 IP 并复制命令后，
 * onResolved 会重新落盘 last_selected_ip，下一次轮询 ip_changed 回为 false，banner 自行消失。 */
function IpChangedBanner({
  lanIps,
  previousIp,
  port,
  token,
  onResolved,
}: {
  lanIps: string[];
  previousIp: string | null;
  port: number;
  token: string;
  onResolved: (ip: string) => void;
}) {
  const [pick, setPick] = useState(lanIps[0] ?? "");
  const [copied, setCopied] = useState(false);

  const command = pick
    ? `claude mcp add --transport http cc-bridge http://${pick}:${port}/mcp --header "Authorization: Bearer ${token}"`
    : "";

  const handleConfirm = () => {
    if (!command) return;
    navigator.clipboard.writeText(command);
    setCopied(true);
    onResolved(pick);
  };

  return (
    <div className="animate-fade-in space-y-3 rounded-lg border border-destructive/35 bg-destructive/[0.08] p-4">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-destructive/15 text-destructive">
          <Icon name="alertTriangle" size={15} />
        </div>
        <div>
          <p className="text-sm font-semibold text-destructive">检测到网络地址变化</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            之前使用的 <code className="rounded bg-background px-1">{previousIp}</code> 已不在本机网卡列表中（大概率是
            VPN 重新连接分配了新地址）。请确认下面的新地址，更新远程服务器上的连接命令。
          </p>
        </div>
      </div>

      {lanIps.length > 0 && (
        <div className="grid grid-cols-2 gap-2 pl-[38px]">
          {lanIps.map((ip, i) => {
            const sel = pick === ip;
            return (
              <button
                key={ip}
                onClick={() => setPick(ip)}
                className={`relative rounded-md border-2 px-3 py-2 text-left transition-colors ${
                  sel ? "border-primary bg-accent" : "border-transparent bg-background hover:bg-muted"
                }`}
              >
                <div className="flex items-center gap-2">
                  <code className={`text-sm font-mono ${sel ? "text-primary" : ""}`}>{ip}</code>
                  {i === 0 && <Badge variant="secondary">默认</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{ipHint(ip)}</p>
              </button>
            );
          })}
        </div>
      )}

      <div className="pl-[38px]">
        <Button size="sm" onClick={handleConfirm} disabled={!command}>
          <Icon name={copied ? "check" : "copy"} size={14} />
          {copied ? "已复制，可以去更新远程了" : "复制新连接命令并标记已处理"}
        </Button>
      </div>
    </div>
  );
}

function AddressPicker({
  ips,
  selected,
  onSelect,
  healthCheck,
}: {
  ips: string[];
  selected: string;
  onSelect: (ip: string) => void;
  healthCheck: string;
}) {
  const [copied, setCopied] = useState(false);
  const copyHealth = () => {
    if (!healthCheck) return;
    navigator.clipboard.writeText(healthCheck);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
      <div>
        <p className="text-sm font-medium">选择远程服务器能连回本机的地址</p>
        <p className="text-xs text-muted-foreground mt-1">
          🔌 通过 <b>VPN</b> 连服务器 → 选 VPN 网段（多为 10.x）；
          🏠 <b>内网直连</b> → 选内网 IP（192.168.x / 172.x）。
          拿不准就逐个试，或用下方命令在服务器上验证哪个通。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {ips.map((ip, i) => {
          const sel = selected === ip;
          return (
            <button
              key={ip}
              onClick={() => onSelect(ip)}
              className={`relative rounded-md border-2 px-3 py-2 text-left transition-colors ${
                sel
                  ? "border-primary bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,hsl(var(--primary))_14%,transparent)]"
                  : "border-transparent bg-background hover:bg-muted"
              }`}
            >
              {sel && (
                <span className="absolute right-1.5 top-1.5 grid h-4 w-4 place-items-center rounded-full bg-primary text-primary-foreground">
                  <Icon name="check" size={10} />
                </span>
              )}
              <div className="flex items-center gap-2">
                <code className={`text-sm font-mono ${sel ? "text-primary" : ""}`}>{ip}</code>
                {i === 0 && <Badge variant="secondary">默认</Badge>}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{ipHint(ip)}</p>
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5 pt-1">
        <p className="text-xs text-muted-foreground">
          在服务器上执行以下命令验证连通（返回 <code className="rounded bg-background px-1">{`{"status":"ok"}`}</code> 即可用该 IP）：
        </p>
        <div className="flex flex-wrap items-start gap-2">
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md bg-background border px-3 py-2 text-xs font-mono">
            {healthCheck}
          </code>
          <Button variant="outline" size="sm" className="shrink-0" onClick={copyHealth} disabled={!healthCheck}>
            <Icon name={copied ? "check" : "copy"} size={14} />
            {copied ? "已复制" : "复制"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 连接页选项卡（模式选择），选中态：靛蓝描边 + 淡底 + 对勾。 */
function OptionCard({
  selected,
  title,
  desc,
  badge,
  onClick,
}: {
  selected: boolean;
  title: string;
  desc: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative rounded-lg border-2 p-3 text-left transition-colors ${
        selected
          ? "border-primary bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,hsl(var(--primary))_14%,transparent)]"
          : "border-transparent bg-muted/50 hover:bg-muted"
      }`}
    >
      {selected && (
        <span className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground">
          <Icon name="check" size={12} />
        </span>
      )}
      <div className="mb-1 flex items-center gap-2">
        <span className={`text-sm font-medium ${selected ? "text-primary" : ""}`}>{title}</span>
        {badge && <Badge variant="secondary">{badge}</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">{desc}</p>
    </button>
  );
}

function CommandBlock({
  command,
  copied,
  onCopy,
}: {
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 items-start">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md bg-background border px-3 py-2 text-xs font-mono leading-relaxed">
        {command || "加载中..."}
      </code>
      <Button variant="outline" size="sm" className="shrink-0 mt-0.5" onClick={onCopy} disabled={!command}>
        <Icon name={copied ? "check" : "copy"} size={14} />
        {copied ? "已复制" : "复制"}
      </Button>
    </div>
  );
}

function GlobalSteps({
  command,
  copied,
  onCopy,
}: {
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <>
      <div className="flex gap-3">
        <StepNumber n={1} />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium">SSH 登录远程 Linux 服务器</p>
          <p className="text-xs text-muted-foreground">在任意目录下执行即可</p>
        </div>
      </div>

      <div className="flex gap-3">
        <StepNumber n={2} />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium">执行连接命令</p>
          <CommandBlock command={command} copied={copied} onCopy={onCopy} />
        </div>
      </div>

      <div className="flex gap-3">
        <StepNumber n={3} />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium">完成</p>
          <p className="text-xs text-muted-foreground">
            配置已写入 <code className="rounded bg-background px-1">~/.claude.json</code>，
            之后在任何项目中启动 <code className="rounded bg-background px-1">claude</code> 都会自动连接 cc-bridge。
          </p>
        </div>
      </div>
    </>
  );
}

function ProjectSteps({
  command,
  copied,
  onCopy,
}: {
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const [projectPath, setProjectPath] = useState("");

  const trimmed = projectPath.trim();
  const fullCommand = trimmed
    ? `cd ${trimmed} && ${command}`
    : command;

  const handleProjectCopy = () => {
    if (!command) return;
    navigator.clipboard.writeText(fullCommand);
    onCopy();
  };

  return (
    <>
      <div className="flex gap-3">
        <StepNumber n={1} />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium">SSH 登录远程 Linux 服务器</p>
        </div>
      </div>

      <div className="flex gap-3">
        <StepNumber n={2} />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium">填写远程项目路径（可选）</p>
          <input
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            placeholder="/home/user/my-project"
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-xs text-muted-foreground">
            {trimmed
              ? "已自动合并为一条命令，复制即可执行"
              : "留空则需要自己先 cd 到项目目录再执行；填写后自动合并为一条命令"}
          </p>
        </div>
      </div>

      <div className="flex gap-3">
        <StepNumber n={3} />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium">
            {trimmed ? "复制并执行" : "在项目目录下执行"}
          </p>
          {!trimmed && (
            <p className="text-xs text-muted-foreground">
              请确保已 <code className="rounded bg-background px-1">cd</code> 到目标项目目录
            </p>
          )}
          <div className="flex flex-wrap gap-2 items-start">
            <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md bg-background border px-3 py-2 text-xs font-mono leading-relaxed">
              {command ? (
                <>
                  {trimmed && <span className="text-muted-foreground">cd {trimmed} && </span>}
                  {command}
                </>
              ) : (
                "加载中..."
              )}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 mt-0.5"
              onClick={handleProjectCopy}
              disabled={!command}
            >
              <Icon name={copied ? "check" : "copy"} size={14} />
              {copied ? "已复制" : "复制"}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex gap-3">
        <StepNumber n={4} />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium">完成</p>
          <p className="text-xs text-muted-foreground">
            配置已写入项目目录的 <code className="rounded bg-background px-1">.mcp.json</code>，
            仅在该项目中启动 <code className="rounded bg-background px-1">claude</code> 时生效。
            如需给其他项目也添加，修改上方路径后再次复制执行即可。
          </p>
        </div>
      </div>
    </>
  );
}
