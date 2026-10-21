import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke, invokeOrToast } from "../lib/tauri";
import type { StaticStatus, StatusResponse, TlsStatus } from "../lib/types";
import {
  McpScope,
  buildDisplayHost,
  buildBaseCommand,
  buildConnectCommand,
  buildHealthCheck,
  buildPermissionGrantCommand,
  buildMultiDeviceCommand,
} from "../lib/utils";
import { useCopyFeedback } from "./useCopyFeedback";

/** 接入配置与复制反馈；所有主要操作常驻，不再维护互斥展开状态。 */
export function useConnectGuideState(status: StaticStatus | undefined, selectedIp: string) {
  const [{ scope, projectPath }, setLocation] = useState({ scope: "project" as McpScope, projectPath: "" });
  const setScope = (scope: McpScope) => setLocation(previous => ({ ...previous, scope }));
  const setProjectPath = (projectPath: string) => setLocation(previous => ({ ...previous, projectPath }));
  const [includeShellTools, setIncludeShellTools] = useState(false);
  const multiDevice = !!status?.multiDeviceMode && (status.connectClient ?? "claude-code") === "claude-code";
  const effectiveScope = multiDevice ? "user" : scope;
  const { copy, isCopied } = useCopyFeedback();

  // P2-3：TLS 开关状态（与设置页共享 ["tls-status"] 缓存）。决定 URL/命令用 http 还是 https。
  const { data: tls } = useQuery({
    queryKey: ["tls-status"],
    queryFn: () => invoke<TlsStatus>("get_tls_status"),
  });
  const tlsEnabled = !!tls?.enabled;

  // ① 峰值时刻：远程**首次调用成功**（totalRequests 观察到 0→1 的事件）时，
  // 命令区显示「✓ 已收到首次调用，配置生效」，不把复制动作当作接入成功。
  // 只认事件（先观察到 0 再观察到 >0）：老用户挂载时就 >0，永不触发。
  const { data: totalRequests } = useQuery<StatusResponse, Error, number>({
    queryKey: ["status"],
    queryFn: () => invoke<StatusResponse>("get_status"),
    select: (s) => s.stats.totalRequests,
  });
  const [firstCallSeen, setFirstCallSeen] = useState(false);
  const prevRequestsRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevRequestsRef.current;
    prevRequestsRef.current = totalRequests ?? null;
    if (prev === 0 && (totalRequests ?? 0) > 0) setFirstCallSeen(true);
  }, [totalRequests]);

  // 保活后也可能在设置页导入配置：只在后端这两个字段实际改变时回填，
  // 不能由每次 status 轮询触发旧草稿自动保存，覆盖刚导入的作用域和路径。
  const savedScope = status ? (status.scope as McpScope | null) ?? "project" : null;
  const savedPath = status?.projectPath ?? "";
  useEffect(() => {
    if (savedScope == null) return;
    setLocation({ scope: savedScope, projectPath: savedPath });
  }, [savedScope, savedPath]);

  // 方案 A：作用域/项目路径一变更立即落盘（300ms 防抖），使托盘端复制的 IP 命令与
  // 连接页一致；status 未加载时不保存，避免挂载即用默认值覆盖后端已存的值。
  // 注意：save_config 的形参名为 patch，字段必须包进 { patch: {...} }，平铺直传
  // 会得到全 None 的 ConfigPatch，静默不落盘（曾因此漏改）。
  useEffect(() => {
    if (savedScope == null || (effectiveScope === savedScope && projectPath === savedPath)) return;
    const t = setTimeout(() => {
      void invokeOrToast("save_config", { patch: { scope: effectiveScope, projectPath: projectPath || null } });
    }, 300);
    return () => clearTimeout(t);
  }, [effectiveScope, projectPath, savedScope, savedPath]);

  // E-P2-8：useMemo 避免每渲染重复拼接命令字符串（纯函数见 lib/utils）。
  const displayHost = useMemo(
    () => buildDisplayHost(status, selectedIp),
    [status, selectedIp],
  );
  const port = status?.port ?? 7823;
  const token = status?.token ?? "";

  const baseCommand = useMemo(
    () => buildBaseCommand(displayHost, port, token, status?.transport, tlsEnabled),
    [displayHost, port, token, status?.transport, tlsEnabled],
  );

  // 多设备模式（opt-in）且 Claude Code：连接命令换条目级 remove+add（可并存），
  // 固定 user 作用域，页面与授权命令也必须反映这一实际范围。
  const connectCommand = useMemo(
    () =>
      multiDevice
        ? buildMultiDeviceCommand(displayHost, port, token, status?.transport, tlsEnabled, status?.deviceId)
        : buildConnectCommand(baseCommand, scope),
    [baseCommand, scope, multiDevice, status?.deviceId, displayHost, port, token, status?.transport, tlsEnabled],
  );

  const healthCheck = useMemo(
    () => buildHealthCheck(displayHost, port, tlsEnabled),
    [displayHost, port, tlsEnabled],
  );

  const permissionCommand = useMemo(
    () => buildPermissionGrantCommand(effectiveScope, projectPath, includeShellTools),
    [effectiveScope, projectPath, includeShellTools],
  );

  // 复制连接命令（反馈规范：成功仅内联，不再弹 success toast；失败 toast）。
  // H1 修复语义保留：允许调用方指定要复制的命令（ConnectCommand 传含 cd 前缀的完整
  // 命令），缺省则复制 connectCommand——避免双写覆盖导致 cd 前缀丢失。
  // 业务副作用走 onCopied：落盘 scope/projectPath + 首次接入标记 has_onboarded
  // （后端只增不减；每次复制都带 true，幂等且能在配置被重置后自愈）。
  const copyConnect = (cmd?: string) => {
    const target = cmd ?? connectCommand;
    if (!target) return;
    copy("connect", target, {
      onCopied: () => {
        void invokeOrToast("save_config", {
          patch: { scope: effectiveScope, projectPath: projectPath || null, hasOnboarded: true },
        });
      },
    });
  };

  const copyPerm = () => {
    if (permissionCommand) copy("perm", permissionCommand);
  };

  return {
    scope: effectiveScope,
    multiDevice,
    setScope,
    projectPath,
    setProjectPath,
    includeShellTools,
    setIncludeShellTools,
    firstCallSeen,
    tlsEnabled,
    displayHost,
    port,
    token,
    connectCommand,
    healthCheck,
    permissionCommand,
    copyConnect,
    copyPerm,
    isCopied,
  };
}

/** useConnectGuideState 的返回值整体类型，供 ConnectGuide 等 props 引用。 */
export type ConnectGuideState = ReturnType<typeof useConnectGuideState>;
