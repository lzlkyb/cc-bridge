import { useEffect, useRef, useState } from "react";
import { invoke } from "../../../lib/tauri";
import { copyText } from "../../../lib/utils";
import { toast } from "../../ui/toast";
import { Icon } from "../../ui/icon";
import { CommandBlock } from "./widgets";
import "./tunnel-flow.css";

interface IpSedCommandResult {
  cmd: string;
  scopeLabel: string;
}

/**
 * 「IP 直连 → 隧道连接」的手动兜底命令。
 *
 * 自动配置会在同名冲突、目录权限、远端脚本超时这些地方失败，失败后用户手上只剩一条
 * 写着旧直连地址的 `.mcp.json`，没有任何自助手段——只能来提工单。这条命令补的就是这一步：
 * 把 `http://<旧地址>:<端口>/mcp` 原地改成 `http://127.0.0.1:<隧道端口>/mcp`。
 *
 * 🔴 只换地址，不换令牌。同一台设备在直连与隧道下用的是同一个令牌，所以一条 sed 就够；
 * 反过来，若服务器上那条的令牌确实与本机不同（`tokenMatches === false`），这条命令修不好
 * 401，那种情况必须回「核对并更新配置」让远端脚本连 Authorization 一起换。文案里点明了这一点。
 *
 * 命令由后端 `get_ip_sed_command` 生成（单一真源，与直连那条 sed 同一套 `sed_in_place`），
 * 这里只负责展示与复制——绝不在前端拼 shell，避免路径转义两处实现分叉。
 */
export function StableManualFix({ tunnelPort, directUrl }: { tunnelPort: number; directUrl?: string }) {
  const [command, setCommand] = useState("");
  const [scopeLabel, setScopeLabel] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    let alive = true;
    setError("");
    void invoke<IpSedCommandResult>("get_ip_sed_command")
      .then(result => {
        if (!alive) return;
        setCommand(result.cmd);
        setScopeLabel(result.scopeLabel);
      })
      .catch(reason => {
        if (alive) setError(String(reason));
      });
    return () => {
      alive = false;
    };
  }, [tunnelPort]);
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    if (!command) return;
    void copyText(
      command,
      () => {
        setCopied(true);
        if (timer.current != null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 2000);
        toast("命令已复制，请在服务器执行后回到 Claude Code 验证。", "success");
      },
      reason => toast(`复制失败：${reason}`, "error"),
    );
  };
  return (
    <details className="tunnel-flow-box tunnel-flow-more">
      <summary>在服务器上手动更新地址（自动配置失败时的兜底） <Icon name="chevronDown" size={14}/></summary>
      <p>
        把下面这条命令粘贴到服务器终端执行：它只把
        {directUrl ? <code> {directUrl} </code> : " 旧的直连地址 "}
        换成 <code>http://127.0.0.1:{tunnelPort}/mcp</code>，令牌与其它字段（<code>env</code>、
        <code>timeout</code>、自定义 header）都保持原样。
      </p>
      <CommandBlock command={command} copied={copied} onCopy={copy} />
      {scopeLabel && <p>写入 {scopeLabel}。执行后回到 Claude Code 输入 <code>/mcp</code> 确认已连接。</p>}
      {error && <p>暂时拿不到这条命令：{error}</p>}
      <p>
        若 <code>/mcp</code> 提示未授权，说明服务器上的令牌与本机不一致，这条命令不解决——
        请回到「核对并更新配置」让它连令牌一起更新。
      </p>
    </details>
  );
}
