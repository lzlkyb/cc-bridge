import { useState, useEffect, useMemo, memo } from "react";
import { invoke } from "../../lib/tauri";
import type { StatusResponse } from "../../lib/types";
import { APP_INFO } from "../../lib/about";
import { McpScope, buildDisplayHost, buildBaseCommand, buildConnectCommand, buildHealthCheck, buildPermissionGrantCommand, ipHint } from "../../lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Icon } from "../ui/icon";
import { Switch } from "../ui/switch";
import { Alert } from "../ui/alert";
import { useToast } from "../ui/toast";
import { ConnectHero } from "./ConnectHero";
import { TokenManager } from "./TokenManager";

function ConnectTabImpl({
  status,
  onRefresh,
  selectedIp,
  onSelectIp,
  ipResolvedByUser,
  onSedResolved,
}: {
  status?: StatusResponse;
  onRefresh: () => void;
  selectedIp: string;
  onSelectIp: (ip: string) => void;
  /** 方案 Q: 用户已点选新地址但未复制远程更新命令的中间态（App 层提升），用于保持 banner 可见 */
  ipResolvedByUser: boolean;
  /** 方案 Q: 复制远程更新 sed 命令后收口，通知 App 清除 ipResolvedByUser */
  onSedResolved: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [scope, setScope] = useState<McpScope>("project");
  const [projectPath, setProjectPath] = useState("");
  const [includeShellTools, setIncludeShellTools] = useState(false);
  const [permCopied, setPermCopied] = useState(false);
  const lanIps = status?.lanIps ?? [];
  const { toast } = useToast();

  // 监听全网卡时才需要选 IP；host 指定了具体地址就用它
  const listenAll = status?.host === "0.0.0.0";

  useEffect(() => {
    if (!listenAll || lanIps.length === 0) return;
    // 仅在「后端确实从没记录过选中 IP」时默认选第一个。已选但现在不在列表中
    // （地址变化）不在这里静静换新选中——那正是下方 IpChangedBanner 要提示用户
    // 确认的情形。
    // 注意：不能用本地 selectedIp 判断「从未选过」——它每次冷启动都会重置为 ""，
    // 会导致每次启动都把后端 last_selected_ip 覆盖成 lan_ips[0]（物理网卡 IP，永不
    // 消失），从而让 ip_changed 永远无法触发，弱提示全部失效（见诊断报告）。
    if (!selectedIp && !status?.lastSelectedIp) {
      onSelectIp(lanIps[0]);
    }
  }, [listenAll, lanIps.join(","), selectedIp, status?.lastSelectedIp]);

  // E-P2-8: useMemo 避免每渲染重复拼接命令字符串（纯函数见 lib/utils）
  const displayHost = useMemo(
    () => buildDisplayHost(status, selectedIp),
    [status, selectedIp],
  );
  const port = status?.port ?? 7823;
  const token = status?.token ?? "";

  const baseCommand = useMemo(
    () => buildBaseCommand(displayHost, port, token),
    [displayHost, port, token],
  );

  const connectCommand = useMemo(
    () => buildConnectCommand(baseCommand, scope),
    [baseCommand, scope],
  );

  const healthCheck = useMemo(
    () => buildHealthCheck(displayHost, port),
    [displayHost, port],
  );

  const permissionCommand = useMemo(
    () => buildPermissionGrantCommand(scope, projectPath, includeShellTools),
    [scope, projectPath, includeShellTools],
  );

  const handleCopy = () => {
    if (!connectCommand) return;
    navigator.clipboard.writeText(connectCommand);
    setCopied(true);
    toast("连接命令已复制到剪贴板", "success");
    // 首次接入复制命令时，把当前选中的作用域落盘到后端配置，
    // 供后续 IP 变化 banner / Token 重生成生成精确 sed 命令（方案 A）。
    invoke("save_config", { scope }).catch((e) =>
      console.error("保存接入作用域失败（不影响本次复制）", e),
    );
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePermCopy = () => {
    if (!permissionCommand) return;
    navigator.clipboard.writeText(permissionCommand);
    setPermCopied(true);
    toast("授权命令已复制到剪贴板", "success");
    setTimeout(() => setPermCopied(false), 2000);
  };

  return (
    <div className="space-y-3">
      {/* IP 变化醒目提示：上次确认的 IP 不在本机网卡列表中了（VPN 重连等），引导用户选新地址。
          方案 Q：ipChanged 被乐观清除后，靠 ipResolvedByUser 兜底保持可见，直到用户复制远程更新命令。 */}
      {(status?.ipChanged || ipResolvedByUser) && (
        <IpChangedBanner
          lanIps={lanIps}
          selectedIp={selectedIp}
          previousIp={status?.lastSelectedIp ?? (status?.host && status.host !== "0.0.0.0" ? status.host : null)}
          port={status?.port ?? 7823}
          scope={(status?.scope ?? null) as McpScope | null}
          projectPath={projectPath}
          onResolved={onSelectIp}
          onSedResolved={onSedResolved}
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
          {/* IP 选择器：多网卡时让用户选连接用哪个地址。
              ipChanged 时也照常渲染——真实选择控件交还给它，banner 只负责提示（方案 B 修复"选不了"）。 */}
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
              selected={scope === "user"}
              title="全局模式"
              desc="一次配置，所有项目都能使用"
              onClick={() => setScope("user")}
            />
          </div>

          {/* 接入步骤 */}
          <div className="s-sec-label">接入步骤</div>

          <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
            {scope === "user" ? (
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
                projectPath={projectPath}
                setProjectPath={setProjectPath}
              />
            )}
          </div>

          <div className="my-3.5 h-px bg-border" />

          {/* Token 管理（可折叠，状态内聚在 TokenManager）*/}
          <TokenManager
            status={status}
            onRefresh={onRefresh}
            projectPath={projectPath}
          />

          <div className="my-3.5 h-px bg-border" />

          {/* 权限自动授权：一键生成命令，往 permissions.allow 追加 cc-bridge 工具规则 + 信任该 MCP 服务器，
              免去逐工具重复确认。沿用上方已有的 scope/projectPath，不重复画作用域/路径控件。*/}
          <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
            <div className="s-sec-label">权限自动授权</div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Claude Code 每次调用 cc-bridge 的工具都会弹窗确认。复制下面的命令，粘贴到 Claude Code
              所在终端执行一次，即可免去后续所有工具调用的重复授权 —— 无需重启会话，改完立即生效。
            </p>

            {scope === "project" && !projectPath.trim() && (
              <Alert variant="warning" className="flex items-start gap-2 p-3 text-xs">
                <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
                <span>
                  上方“填写远程项目路径”未填写：命令不带 <code className="rounded bg-background px-1">cd</code>，
                  会直接用执行时终端所在目录拼相对路径{" "}
                  <code className="rounded bg-background px-1">.claude/settings.local.json</code>。
                  若执行时不在目标项目目录下，会悄悄写到错误位置且不会报错。请确保执行前已 cd 到目标
                  项目目录，或在上方填写路径。
                </span>
              </Alert>
            )}

            <div className="s-row">
              <div className="min-w-0 flex-1">
                <p className="s-label">同时免确认命令执行工具</p>
                <p className="s-row-desc mt-0.5">
                  <code className="rounded bg-muted px-1">run_command</code> /{" "}
                  <code className="rounded bg-muted px-1">get_command_output</code> /{" "}
                  <code className="rounded bg-muted px-1">stop_command</code> —— 等价于授予远程任意命令执行能力
                </p>
              </div>
              <Switch
                checked={includeShellTools}
                onChange={setIncludeShellTools}
                variant="danger"
                ariaLabel="同时免确认命令执行工具"
              />
            </div>

            {includeShellTools && (
              <Alert variant="destructive" className="flex items-start gap-2 p-3 text-xs">
                <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
                <span className="leading-relaxed">
                  已开启：生成的命令会免确认执行全部 17 个工具（含命令执行能力）。请仅在完全信任该 cc-bridge 连接时开启此项。
                </span>
              </Alert>
            )}

            <CommandBlock command={permissionCommand} copied={permCopied} onCopy={handlePermCopy} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── Step components ─── */

function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <span
      className={`step-num inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${done ? "step-num--done" : ""}`}
    >
      {done ? "✓" : n}
    </span>
  );
}

/* ─── 连接地址选择器 ─── */

/** 变更醒目 banner：仅 status.ipChanged 为真时渲染。确认选中新 IP 并复制命令后，
 * onResolved 会重新落盘 last_selected_ip，下一次轮询 ip_changed 回为 false，banner 自行消失。 */
function IpChangedBanner({
  lanIps,
  selectedIp,
  previousIp,
  port,
  scope,
  projectPath,
  onResolved,
  onSedResolved,
}: {
  lanIps: string[];
  selectedIp: string;
  previousIp: string | null;
  port: number;
  /** 持久化作用域（首次接入落盘）。null 表示旧数据未记录，此时展示两条命令兜底 */
  scope: McpScope | null;
  projectPath: string;
  onResolved: (ip: string) => void;
  /** 方案 Q: 复制远程更新命令后通知 App 收口（清除 ipResolvedByUser），banner 随后自然消失 */
  onSedResolved: () => void;
}) {
  const [copiedCmd, setCopiedCmd] = useState("");

  // P2: 网卡全部消失时,下方选择控件与确认按钮会永久 disabled 形成死局。
  // 此时只给说明、不渲染选择控件;网络恢复、网卡重新出现后会自动回到正常分支。
  if (lanIps.length === 0) {
    return (
      <div className="animate-fade-in space-y-3 rounded-lg border border-destructive/35 bg-destructive/[0.08] p-4">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-destructive/15 text-destructive">
            <Icon name="alertTriangle" size={15} />
          </div>
          <div>
            <p className="text-sm font-semibold text-destructive">检测到网络地址变化</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              之前使用的 <code className="rounded bg-background px-1">{previousIp ?? "原地址"}</code> 已不在本机网卡列表中,且当前没有任何可用的网络地址。请检查网络连接,恢复后本应用将自动重新检测并更新连接命令。
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 原地替换 url 里的 host：sed 匹配任意旧 IP（[0-9.]*），幂等可重跑，
  // 不动 Bearer、不 remove+add，因此服务器条目与授权状态保留、不会重新授权。
  // 作用域读持久化的 scope（方案 A）：有值→精确单条；null（旧数据）→ user+project 两条兜底，
  // sed 不匹配的配置文件不会误改，用户挑对的跑即可。
  const buildSed = (scp: "user" | "project") => {
    const cfgFile = scp === "user" ? "~/.claude.json" : ".mcp.json";
    const cdPrefix =
      scp === "project" && projectPath.trim() ? `cd ${projectPath.trim()} && ` : "";
    return `${cdPrefix}sed -i 's#http://[0-9.]*:${port}/mcp#http://${selectedIp}:${port}/mcp#g' ${cfgFile}`;
  };

  const entries: { label: string; cmd: string }[] = scope
    ? [
        {
          label: scope === "user" ? "全局（~/.claude.json）" : "项目（.mcp.json）",
          cmd: buildSed(scope),
        },
      ]
    : [
        { label: "全局（~/.claude.json）", cmd: buildSed("user") },
        { label: "项目（.mcp.json）", cmd: buildSed("project") },
      ];

  // 仅当用户已在下方 AddressPicker 选中一个当前在网卡列表中的「新」地址时，
  // 才允许生成/复制 sed（把远程配置里的旧 IP 替换为选中的新 IP）。
  // selectedIp 为空或仍是已消失的旧地址时，sed 无意义，禁用复制。
  const newIpValid = !!selectedIp && lanIps.includes(selectedIp);

  const copyOne = (cmd: string) => {
    if (!cmd || !newIpValid) return;
    navigator.clipboard.writeText(cmd);
    setCopiedCmd(cmd);
    onResolved(selectedIp);
    onSedResolved(); // 方案 Q: 收口——复制远程更新命令后允许 banner 自然消失
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
              网络重新连接后分配了新地址）。请在下方「选择远程服务器能连回本机的地址」中选中新地址，连接命令会自动更新，复制后到远程服务器执行即可原地更新 IP（无需重新授权）。
            </p>
        </div>
      </div>

      {newIpValid ? (
        <div className="pl-[38px] space-y-3">
          <p className="text-xs text-muted-foreground">
            {scope
              ? "已选中新地址，复制以下命令到远程服务器执行（原地更新 IP，不会重新授权）："
              : `未能确认当初的接入作用域，请选择你最初添加 ${APP_INFO.name} 时使用的作用域执行对应命令（不匹配的配置文件不会被改动）：`}
          </p>
          {entries.map((e, i) => (
            <div key={i} className="space-y-1.5">
              <p className="text-xs font-medium text-foreground/80">{e.label}</p>
              <CommandBlock
                command={e.cmd}
                copied={copiedCmd === e.cmd}
                onCopy={() => copyOne(e.cmd)}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="pl-[38px] text-xs text-muted-foreground">
          在下方选一个新地址后，这里会自动生成「原地更新 IP」的远程命令。
        </p>
      )}
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
          <Icon name="plug" size={13} className="inline-block align-[-2px] mr-1" aria-hidden="true" /> 通过 <b>VPN</b> 连服务器 → 选 VPN 网段（多为 10.x）；
          <Icon name="monitor" size={13} className="inline-block align-[-2px] mr-1" aria-hidden="true" /> <b>内网直连</b> → 选内网 IP（192.168.x / 172.x）。
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
    <div className="code-box flex items-start gap-2">
      <span className="mt-[1px] shrink-0 font-mono text-xs font-semibold text-primary/30">$</span>
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground">
        {command || "加载中..."}
      </code>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onCopy} disabled={!command}>
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
      <div className="step-row flex gap-3">
        <StepNumber n={1} />
        <div className="flex-1 space-y-1.5">
          <p className="text-[12.5px] font-semibold">SSH 登录远程 Linux 服务器</p>
          <p className="text-xs text-muted-foreground">在任意目录下执行即可</p>
        </div>
      </div>

      <div className="step-row flex gap-3">
        <StepNumber n={2} />
        <div className="flex-1 space-y-2">
          <p className="text-[12.5px] font-semibold">执行连接命令</p>
          <CommandBlock command={command} copied={copied} onCopy={onCopy} />
        </div>
      </div>

      <div className="step-row flex gap-3">
        <StepNumber n={3} done />
        <div className="flex-1 space-y-1.5">
          <p className="text-[12.5px] font-semibold">完成</p>
          <p className="text-xs text-muted-foreground">
            配置已写入 <code className="rounded bg-muted px-1">~/.claude.json</code>，
            之后在任何项目中启动 <code className="rounded bg-muted px-1">claude</code> 都会自动连接 {APP_INFO.name}。
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
  projectPath,
  setProjectPath,
}: {
  command: string;
  copied: boolean;
  onCopy: () => void;
  projectPath: string;
  setProjectPath: (v: string) => void;
}) {
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
      <div className="step-row flex gap-3">
        <StepNumber n={1} />
        <div className="flex-1 space-y-1.5">
          <p className="text-[12.5px] font-semibold">SSH 登录远程 Linux 服务器</p>
        </div>
      </div>

      <div className="step-row flex gap-3">
        <StepNumber n={2} />
        <div className="flex-1 space-y-2">
          <p className="text-[12.5px] font-semibold">填写远程项目路径（可选）</p>
          <p className="text-xs text-muted-foreground">
            如需进入特定目录执行，填入路径后命令前会自动加 <code className="rounded bg-muted px-1">cd</code>
          </p>
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

      <div className="step-row flex gap-3">
        <StepNumber n={3} />
        <div className="flex-1 space-y-2">
          <p className="text-[12.5px] font-semibold">
            {trimmed ? "复制并执行" : "在项目目录下执行"}
          </p>
          {!trimmed && (
            <p className="text-xs text-muted-foreground">
              请确保已 <code className="rounded bg-muted px-1">cd</code> 到目标项目目录
            </p>
          )}
          <CommandBlock command={fullCommand} copied={copied} onCopy={handleProjectCopy} />
        </div>
      </div>

      <div className="step-row flex gap-3">
        <StepNumber n={4} done />
        <div className="flex-1 space-y-1.5">
          <p className="text-[12.5px] font-semibold">完成</p>
          <p className="text-xs text-muted-foreground">
            配置已写入项目目录的 <code className="rounded bg-muted px-1">.mcp.json</code>，
            仅在该项目中启动 <code className="rounded bg-muted px-1">claude</code> 时生效。
            如需给其他项目也添加，修改上方路径后再次复制执行即可。
          </p>
        </div>
      </div>
    </>
  );
}

export const ConnectTab = memo(ConnectTabImpl);
