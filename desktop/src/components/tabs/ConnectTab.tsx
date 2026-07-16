import { useState, useEffect, useMemo, memo, useRef } from "react";
import { invoke } from "../../lib/tauri";
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
    void copyText(
      connectCommand,
      () => {
        setCopied(true);
        toast("连接命令已复制到剪贴板", "success");
    // 首次接入复制命令时，把当前选中的作用域落盘到后端配置，
    // 供后续 IP 变化 banner / Token 重生成生成精确 sed 命令（方案 A）。
        invoke("save_config", { scope }).catch((e) =>
          console.error("保存接入作用域失败（不影响本次复制）", e),
        );
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

      {/* Connect guide（主卡）*/}
      <Card className="card-primary">
        <CardHeader>
          <CardTitle icon={<Icon name="plug" />}>接入 Claude Code</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* F2：传输安全提醒——默认监听 0.0.0.0 且 /mcp 目前是明文 HTTP，Bearer token 全程明文传输，
              同网段可被嗅探（README 安全机制节同步说明）。 */}
          <Alert variant="warning" className="flex items-start gap-2 p-3 text-xs">
            <Icon name="shield" size={14} className="mt-0.5 shrink-0" />
            <span>
              传输安全提醒：目前连接是明文 HTTP，Token 全程以明文传输，同网段内可被嗅探。
              请务必只在 <b>VPN</b> 或受信任的内网环境中使用，不要直接暴露到公网。
            </span>
          </Alert>
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

export const ConnectTab = memo(ConnectTabImpl);
