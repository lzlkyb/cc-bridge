import { useState, useEffect, useMemo, memo, useRef } from "react";
import { invokeOrToast } from "../../lib/tauri";
import type { StatusResponse } from "../../lib/types";
import {
  McpScope,
  buildDisplayHost,
  buildBaseCommand,
  buildConnectCommand,
  buildHealthCheck,
  buildPermissionGrantCommand,
  copyText,
} from "../../lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Icon } from "../ui/icon";
import { Switch } from "../ui/switch";
import { Alert } from "../ui/alert";
import { useToast } from "../ui/toast";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";
import { ConnectHero } from "./ConnectHero";
import { TokenManager } from "./TokenManager";
import { IpChangedBanner } from "./connect/IpChangedBanner";
import { FirewallAlertBlock } from "./connect/FirewallAlertBlock";
import { AddressPicker } from "./connect/AddressPicker";
import { OptionCard, CommandBlock } from "./connect/widgets";
import { GlobalSteps, ProjectSteps } from "./connect/Steps";

function ConnectTabImpl({
  status,
  onRefresh,
  selectedIp,
  onSelectIp,
  ipResolvedByUser,
  onSedResolved,
  dismissed,
  onDismissIpChange,
}: {
  status?: StatusResponse;
  onRefresh: () => void;
  selectedIp: string;
  onSelectIp: (ip: string) => void;
  /** 方案 Q: 用户已点选新地址但未复制远程更新命令的中间态（App 层提升），用于保持 banner 可见 */
  ipResolvedByUser: boolean;
  /** 方案 Q: 复制远程更新 sed 命令后收口，通知 App 清除 ipResolvedByUser */
  onSedResolved: () => void;
  /** 方案 R: 用户点关闭按钮「本次会话忽略此 IP 变化提示」（App 层提升），用于隐藏 banner */
  dismissed?: boolean;
  /** 方案 R: 关闭按钮回调，通知 App 置 ipChangeDismissed=true */
  onDismissIpChange?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [scope, setScope] = useState<McpScope>("project");
  const [projectPath, setProjectPath] = useState("");
  const [includeShellTools, setIncludeShellTools] = useState(false);
  const [permCopied, setPermCopied] = useState(false);
  const lanIps = status?.lanIps ?? [];
  const { toast } = useToast();

  type Section = "scope" | "steps" | "token" | "perm";
  // 默认折叠（单选聚焦）：进连接页四块均收起，用户按需点开。
  // 原「首次接入四块全展开」引导依赖 localStorage 标记，无法区分「真新用户」与「升级的老用户」
  // （旧版没写过该标记，老用户升级后首次进入会被误判为新用户全展开），且 scope / lastSelectedIp
  // 均会被首启自动副作用污染，故改为默认折叠，更贴合老用户习惯。
  const [expanded, setExpanded] = useState<Section | null>(null);
  const handleToggle = (section: Section) => {
    setExpanded((prev) => (prev === section ? null : section));
  };

  // 链路是否真正中断（红态）：服务在跑，但地址变了或探针不通（远程连不回本机）。
  // 防火墙告警块在链路未中断时才显示——红态优先于橙态，避免叠加制造混乱（设计稿规则）。
  const linkDown =
    !!status && !!status.running && (status.ipChanged || status.remoteReachable === false);

  // 地址变化 banner 显示期间，固化「之前使用的地址」，避免选新地址落盘后
  // lastSelectedIp 变成新地址、把"之前使用"误显示为刚选的新地址（残留 bug 修复）。
  const prevIpRef = useRef<string | null>(null);
  useEffect(() => {
    const show = !!status?.ipChanged || ipResolvedByUser;
    if (show && prevIpRef.current == null) {
      prevIpRef.current =
        status?.lastSelectedIp ??
        (status?.host && status.host !== "0.0.0.0" ? status.host : null);
    } else if (!show) {
      prevIpRef.current = null;
    }
  }, [status?.ipChanged, status?.lastSelectedIp, ipResolvedByUser, status?.host]);

  // 监听全网卡时才需要选 IP；host 指定了具体地址就用它
  const listenAll = status?.host === "0.0.0.0";

  useEffect(() => {
    if (!listenAll || lanIps.length === 0) return;
    // 场景 1：后端从没记录过选中 IP → 默认选第一个（首次接入）。
    // 注意：不能用本地 selectedIp 判断「从未选过」——它每次冷启动都会重置为 ""，
    // 会导致每次启动都把后端 last_selected_ip 覆盖成 lan_ips[0]（物理网卡 IP，永不
    // 消失），从而让 ip_changed 永远无法触发，弱提示全部失效（见诊断报告）。
    if (!selectedIp && !status?.lastSelectedIp) {
      onSelectIp(lanIps[0]);
      return;
    }
    // 场景 2：当前选中 IP 已不在网卡列表（地址变化，如 DHCP 续租 / 换网）——
    // 自动预选第一个可用地址作为候选，让 IP 变化 banner 立即给出可复制的 sed 命令；
    // 用户仍可在 AddressPicker 中改选。仅当「当前选中已失效」时触发，绝不覆盖用户
    // 确认过的有效地址（避免静默切换）。
    if (selectedIp && !lanIps.includes(selectedIp)) {
      onSelectIp(lanIps[0]);
    }
  }, [listenAll, lanIps.join(","), selectedIp, status?.lastSelectedIp]);

  // H1 修复：从后端回填 scope / projectPath，避免每次进入连接页被静默重置为默认值。
  // status 异步加载，挂载时可能 undefined，故在 status 就绪后回填一次（仅当后端有值时）。
  useEffect(() => {
    if (status?.scope) setScope(status.scope as McpScope);
    if (status?.projectPath != null) setProjectPath(status.projectPath);
  }, [status?.scope, status?.projectPath]);

  // 方案 A：作用域/项目路径一变更立即落盘，使托盘端复制的 IP 命令与连接页一致。
  // 否则连接页用 UI 本地 scope（默认 project），托盘读持久化 config.scope（默认 None→user），
  // 两者来源不同会不一致。此处让 config.scope 始终等于 UI 选择。
  // H1 修复：status 未加载时不保存，避免挂载即用默认值（project/""）覆盖后端已存的值。
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => {
      // 注意：save_config 命令的形参名为 patch，前端必须把字段包进 { patch: {...} }，
      // 否则 Tauri 取到的是空 ConfigPatch（全部 None），scope 静默不落盘且不报错（曾因此漏改）。
      void invokeOrToast("save_config", { patch: { scope, projectPath: projectPath || null } });
    }, 300);
    return () => clearTimeout(t);
  }, [scope, projectPath]);

  // E-P2-8: useMemo 避免每渲染重复拼接命令字符串（纯函数见 lib/utils）
  const displayHost = useMemo(
    () => buildDisplayHost(status, selectedIp),
    [status, selectedIp],
  );
  const port = status?.port ?? 7823;
  const token = status?.token ?? "";

  const baseCommand = useMemo(
    () => buildBaseCommand(displayHost, port, token, status?.transport),
    [displayHost, port, token, status?.transport],
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

  const handleCopy = (cmd?: string) => {
    // H1 修复：允许调用方指定要复制的命令（ProjectSteps 传含 cd 前缀的完整命令），
    // 缺省则复制 connectCommand。避免此前 ProjectSteps 先自行 writeText(fullCommand) 再调
    // 本函数二次 writeText(connectCommand) 造成的双写覆盖（cd 前缀丢失）。
    const target = cmd ?? connectCommand;
    if (!target) return;
    void copyText(
      target,
      () => {
        setCopied(true);
        toast("连接命令已复制到剪贴板", "success");
    // 首次接入复制命令时，把当前选中的作用域落盘到后端配置，
    // 供后续 IP 变化 banner / Token 重生成生成精确 sed 命令（方案 A）。
        void invokeOrToast("save_config", { patch: { scope, projectPath: projectPath || null } });
        setTimeout(() => setCopied(false), 2000);
      },
      (e) => toast(`复制失败：${e}`, "error"),
    );
  };

  const handlePermCopy = () => {
    if (!permissionCommand) return;
    void copyText(
      permissionCommand,
      () => {
        setPermCopied(true);
        toast("授权命令已复制到剪贴板", "success");
        setTimeout(() => setPermCopied(false), 2000);
      },
      (e) => toast(`复制失败：${e}`, "error"),
    );
  };

  return (
    <div className="space-y-3">
      {/* 防火墙告警块：仅 Windows 防火墙开 + 未放行 7823，且链路未真正中断（红态优先）。
          诚实暴露本机探针对远程入站拦截的盲点——不再谎报绿色「已连接」。 */}
      {status?.running &&
        status.firewallEnabled === true &&
        status.firewallPortOpen === false &&
        !linkDown && <FirewallAlertBlock port={status.port} onRefresh={onRefresh} />}

      {/* 防火墙探测不可用（netsh 异常）：温和提示，不弹系统错误框。
          与上方橙色告警互斥——netsh 损坏时 firewallEnabled/portOpen 均为 null，橙色块不会渲染。 */}
      {status?.firewallAvailable === false && (
        <div className="animate-fade-in space-y-2 rounded-lg border border-border bg-secondary/40 p-4">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
              <Icon name="info" size={15} />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">防火墙状态暂不可用</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                无法查询系统防火墙状态（系统 <code className="rounded bg-background px-1">netsh</code> 异常，错误码 0xc0000142）。这<strong>不影响服务运行与远程连接</strong>——仅本机的防火墙探测被停用，以避免反复弹出系统错误框。如需恢复状态显示，请以管理员身份运行 <code className="rounded bg-background px-1">sfc /scannow</code> 修复后重启本应用。
              </p>
            </div>
          </div>
        </div>
      )}

      {/* IP 变化醒目提示：上次确认的 IP 不在本机网卡列表中了（VPN 重连等），引导用户选新地址。
          方案 Q：ipChanged 被乐观清除后，靠 ipResolvedByUser 兜底保持可见，直到用户复制远程更新命令。 */}
      {(status?.ipChanged || ipResolvedByUser) && !dismissed && (
        <IpChangedBanner
          lanIps={lanIps}
          selectedIp={selectedIp}
          previousIp={prevIpRef.current}
          port={status?.port ?? 7823}
          scope={scope}
          projectPath={projectPath}
          onResolved={onSelectIp}
          onSedResolved={onSedResolved}
          onDismiss={onDismissIpChange}
        />
      )}

      {/* A. Hero 渐变头卡：运行状态 + 地址 + 关键指标 + 启停按钮 */}
      <ConnectHero
        status={status}
        displayHost={displayHost}
        port={port}
        onChanged={onRefresh}
      />

      <ConnectGuide
        status={status}
        listenAll={listenAll} lanIps={lanIps} selectedIp={selectedIp}
        onSelectIp={onSelectIp} healthCheck={healthCheck}
        scope={scope} setScope={setScope}
        connectCommand={connectCommand} copied={copied} handleCopy={handleCopy}
        projectPath={projectPath} setProjectPath={setProjectPath}
        onRefresh={onRefresh}
        includeShellTools={includeShellTools} setIncludeShellTools={setIncludeShellTools}
        permissionCommand={permissionCommand} permCopied={permCopied}
        handlePermCopy={handlePermCopy}
        expanded={expanded} onToggle={handleToggle}
      />
    </div>
  );
}

function ConnectGuide({
  status, listenAll, lanIps, selectedIp, onSelectIp, healthCheck,
  scope, setScope, connectCommand, copied, handleCopy,
  projectPath, setProjectPath, onRefresh,
  includeShellTools, setIncludeShellTools, permissionCommand, permCopied, handlePermCopy,
  expanded, onToggle,
}: {
  status?: StatusResponse;
  listenAll: boolean; lanIps: string[]; selectedIp: string;
  onSelectIp: (ip: string) => void; healthCheck: string;
  scope: McpScope; setScope: (s: McpScope) => void;
  connectCommand: string; copied: boolean; handleCopy: (command?: string) => void;
  projectPath: string; setProjectPath: (p: string) => void;
  onRefresh: () => void;
  includeShellTools: boolean; setIncludeShellTools: (v: boolean) => void;
  permissionCommand: string; permCopied: boolean; handlePermCopy: () => void;
  expanded: string | null; onToggle: (s: "scope" | "steps" | "token" | "perm") => void;
}) {
  const isOpen = (k: "scope" | "steps" | "token" | "perm") => expanded === k;
  const scopeOpen = isOpen("scope");
  const stepsOpen = isOpen("steps");
  const permOpen = isOpen("perm");
  const scopeBody = useAutoAnimateRM<HTMLDivElement>();
  const stepsBody = useAutoAnimateRM<HTMLDivElement>();
  const permBody = useAutoAnimateRM<HTMLDivElement>();
  const scopeBtn = useRef<HTMLButtonElement>(null);
  const stepsBtn = useRef<HTMLButtonElement>(null);
  const permBtn = useRef<HTMLButtonElement>(null);

  const scrollToBtn = (el: HTMLElement | null) => {
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      window.scrollBy({ top: -60, behavior: "instant" });
    });
  };

  // 首屏不自动滚动（避免进入即跳动）；仅用户主动展开对应块时才平滑滚动到该块
  const scopeMounted = useRef(false);
  const stepsMounted = useRef(false);
  const permMounted = useRef(false);
  useEffect(() => { if (!scopeMounted.current) { scopeMounted.current = true; return; } if (scopeOpen) scrollToBtn(scopeBtn.current); }, [scopeOpen]);
  useEffect(() => { if (!stepsMounted.current) { stepsMounted.current = true; return; } if (stepsOpen) scrollToBtn(stepsBtn.current); }, [stepsOpen]);
  useEffect(() => { if (!permMounted.current) { permMounted.current = true; return; } if (permOpen) scrollToBtn(permBtn.current); }, [permOpen]);
  return (
    <Card className="card-primary">
      <CardHeader>
        <CardTitle icon={<Icon name="plug" />}>接入 Claude Code</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {listenAll && lanIps.length > 0 && (
          <AddressPicker ips={lanIps} selected={selectedIp} onSelect={onSelectIp} healthCheck={healthCheck} onRefresh={onRefresh} />
        )}
        <button
          type="button"
          onClick={() => onToggle("scope")}
          className="collapsible-head w-full text-left"
          aria-expanded={scopeOpen}
          ref={scopeBtn}
        >
          <span className="step-num inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-white bg-gradient-to-br from-primary to-primary/70">
            <Icon name="sliders" size={14} aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="ui-h-sub text-foreground">接入模式</div>
            {!scopeOpen && (
              <div className="text-[11px] text-muted-foreground">
                {scope === "project" ? "项目级 · 仅指定项目生效" : "全局模式 · 所有项目可用"}
              </div>
            )}
          </div>
          <Icon
            name="chevronDown"
            size={16}
            className={`collapsible-chev ${scopeOpen ? "open" : ""}`}
            aria-hidden="true"
          />
        </button>
        <div ref={scopeBody}>
          {scopeOpen && (
            <div className="collapsible-body pl-9">
              <div className="grid grid-cols-2 gap-3">
                {([
                  { key: "project", title: "项目级", desc: "仅指定项目生效", badge: "推荐" as const },
                  { key: "user", title: "全局模式", desc: "一次配置，所有项目都能使用" },
                ] as const).map((o) => (
                  <OptionCard key={o.key} selected={scope===o.key} title={o.title} desc={o.desc}
                    badge={"badge" in o ? o.badge : undefined} onClick={()=>setScope(o.key)} />
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="my-3.5 h-px bg-border" />
        <button
          type="button"
          onClick={() => onToggle("steps")}
          className="collapsible-head w-full text-left"
          aria-expanded={stepsOpen}
          ref={stepsBtn}
        >
          <span className="step-num inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-white bg-gradient-to-br from-primary to-primary/70">
            <Icon name="terminal" size={14} aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="ui-h-sub text-foreground">
              接入步骤
              <span className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${status?.transport === "sse" ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200" : "bg-indigo-50 text-indigo-600 dark:bg-indigo-900 dark:text-indigo-200"}`}>
                {status?.transport === "sse" ? "SSE 流式" : "HTTP"}
              </span>
            </div>
            {!stepsOpen && (
              <div className="text-[11px] text-muted-foreground">点击展开查看连接命令</div>
            )}
          </div>
          <Icon
            name="chevronDown"
            size={16}
            className={`collapsible-chev ${stepsOpen ? "open" : ""}`}
            aria-hidden="true"
          />
        </button>
        <div ref={stepsBody}>
          {stepsOpen && (
            <div className="collapsible-body pl-9">
              {scope === "user" ? (
                <GlobalSteps command={connectCommand} copied={copied} onCopy={handleCopy} />
              ) : (
                <ProjectSteps command={connectCommand} copied={copied} onCopy={handleCopy}
                  projectPath={projectPath} setProjectPath={setProjectPath} />
              )}
            </div>
          )}
        </div>
        <div className="my-3.5 h-px bg-border" />
        <TokenManager status={status} onRefresh={onRefresh} projectPath={projectPath}
          expanded={isOpen("token")} onToggle={() => onToggle("token")} />
        <button
          type="button"
          onClick={() => onToggle("perm")}
          className="collapsible-head w-full text-left"
          aria-expanded={permOpen}
          ref={permBtn}
        >
          <span className="step-num inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-white bg-gradient-to-br from-emerald-500 to-emerald-600">
            <Icon name="check" size={14} aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="ui-h-sub text-foreground">权限自动授权</div>
            {!permOpen && (
              <div className="text-[11px] text-muted-foreground">点击展开查看授权命令</div>
            )}
          </div>
          <Icon
            name="chevronDown"
            size={16}
            className={`collapsible-chev ${permOpen ? "open" : ""}`}
            aria-hidden="true"
          />
        </button>
        <div ref={permBody}>
          {permOpen && (
            <div className="collapsible-body pl-9">
              <PermissionCard scope={scope} projectPath={projectPath}
                includeShellTools={includeShellTools} setIncludeShellTools={setIncludeShellTools}
                permissionCommand={permissionCommand} permCopied={permCopied} handlePermCopy={handlePermCopy} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PermissionCard({
  scope, projectPath, includeShellTools, setIncludeShellTools,
  permissionCommand, permCopied, handlePermCopy,
}: {
  scope: McpScope; projectPath: string;
  includeShellTools: boolean; setIncludeShellTools: (v: boolean) => void;
  permissionCommand: string; permCopied: boolean; handlePermCopy: () => void;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
      <div className="s-sec-label">权限自动授权</div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        复制命令到远端终端执行一次，即可免去 Claude Code 对 cc-bridge 全部工具的重复授权。
      </p>
      {scope === "project" && !projectPath.trim() && (
        <Alert variant="warning" className="flex items-start gap-2 p-3 text-xs">
          <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
          <span>上方路径未填写——命令不带 <code className="rounded bg-background px-1">cd</code>，写错位置不会报错。</span>
        </Alert>
      )}
      <div className="s-row">
        <div className="min-w-0 flex-1">
          <p className="s-label">同时免确认命令执行工具</p>
          <p className="s-row-desc mt-0.5">
            开启后 <code className="rounded bg-muted px-1">run_command</code> 等命令类工具也免确认。
          </p>
        </div>
        <Switch checked={includeShellTools} onChange={setIncludeShellTools} variant="danger" ariaLabel="同时免确认命令执行工具" />
      </div>
      {includeShellTools && (
        <Alert variant="destructive" className="flex items-start gap-2 p-3 text-xs">
          <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
          <span className="leading-relaxed">已开启：生成的命令会免确认全部 17 个工具（含命令执行）。请仅在完全信任该连接时开启。</span>
        </Alert>
      )}
      <CommandBlock command={permissionCommand} copied={permCopied} onCopy={handlePermCopy} />
    </div>
  );
}

export const ConnectTab = memo(ConnectTabImpl);
