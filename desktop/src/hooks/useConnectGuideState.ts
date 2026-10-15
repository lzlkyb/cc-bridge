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
} from "../lib/utils";
import { useCopyFeedback } from "./useCopyFeedback";

/** 向导四个可折叠区块。 */
export type GuideSection = "scope" | "steps" | "token" | "perm";

/**
 * 连接页接入向导的全部局部状态（评审修复 ⑤ 结构收敛）。
 *
 * 原 ConnectTab 承载 6 个 useState + 6 个命令 useMemo + 两套复制反馈 + 18 个 props
 * 透传，导致复制反馈无法收口（全页出现六套实现）。本 hook 把这些状态下沉为一个
 * 整体对象，ConnectGuide 以 8 个 props 接收，复制反馈统一走 useCopyFeedback。
 *
 * 同时承载评审修复 ① P0：`expanded` 的初始值由后端 `has_onboarded` 决定——
 * 真新用户（首次复制连接命令成功才落盘，只增不减）进门即见「接入步骤」展开，
 * 老用户（字段缺省 true）行为与现状完全一致。
 */
export function useConnectGuideState(status: StaticStatus | undefined, selectedIp: string) {
  const [{ scope, projectPath }, setLocation] = useState({ scope: "project" as McpScope, projectPath: "" });
  const setScope = (scope: McpScope) => setLocation(previous => ({ ...previous, scope }));
  const setProjectPath = (projectPath: string) => setLocation(previous => ({ ...previous, projectPath }));
  const [includeShellTools, setIncludeShellTools] = useState(false);
  // 默认折叠（单选聚焦）：展开「接入步骤」时其余收起。此处只定初始值——
  // 真新用户（后端 has_onboarded=false）进门即展开「接入步骤」；老用户全收起，
  // 与升级前行为一致。挂载时 status 尚未加载（冷启动直进连接页）的兜底见下方
  // status 就绪 effect。判定权在后端而非 localStorage：localStorage 无法区分
  // 「真新用户」与「升级的老用户」，且会被首启副作用污染（旧注释自认的问题）。
  const [expanded, setExpanded] = useState<GuideSection | null>(
    () => (status?.hasOnboarded === false ? "steps" : null),
  );
  const { copy, isCopied } = useCopyFeedback();

  // P2-3：TLS 开关状态（与设置页共享 ["tls-status"] 缓存）。决定 URL/命令用 http 还是 https。
  const { data: tls } = useQuery({
    queryKey: ["tls-status"],
    queryFn: () => invoke<TlsStatus>("get_tls_status"),
  });
  const tlsEnabled = !!tls?.enabled;

  // ① 峰值时刻：远程**首次调用成功**（totalRequests 观察到 0→1 的事件）时，
  // 「接入步骤」折叠头摘要换成「✓ 已收到首次调用，配置生效」。不新增常驻 UI。
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

  // 首次加载仅处理新用户的展开状态；配置值由上方字段级同步负责。
  const statusInitRef = useRef(false);
  useEffect(() => {
    if (statusInitRef.current || status == null) return;
    statusInitRef.current = true;
    if (!status.hasOnboarded && expanded == null) setExpanded("steps");
  }, [status, expanded]);

  // 方案 A：作用域/项目路径一变更立即落盘（300ms 防抖），使托盘端复制的 IP 命令与
  // 连接页一致；status 未加载时不保存，避免挂载即用默认值覆盖后端已存的值。
  // 注意：save_config 的形参名为 patch，字段必须包进 { patch: {...} }，平铺直传
  // 会得到全 None 的 ConfigPatch，静默不落盘（曾因此漏改）。
  useEffect(() => {
    if (savedScope == null || (scope === savedScope && projectPath === savedPath)) return;
    const t = setTimeout(() => {
      void invokeOrToast("save_config", { patch: { scope, projectPath: projectPath || null } });
    }, 300);
    return () => clearTimeout(t);
  }, [scope, projectPath, savedScope, savedPath]);

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

  const connectCommand = useMemo(
    () => buildConnectCommand(baseCommand, scope),
    [baseCommand, scope],
  );

  const healthCheck = useMemo(
    () => buildHealthCheck(displayHost, port, tlsEnabled),
    [displayHost, port, tlsEnabled],
  );

  const permissionCommand = useMemo(
    () => buildPermissionGrantCommand(scope, projectPath, includeShellTools),
    [scope, projectPath, includeShellTools],
  );

  // 复制连接命令（反馈规范：成功仅内联，不再弹 success toast；失败 toast）。
  // H1 修复语义保留：允许调用方指定要复制的命令（ProjectSteps 传含 cd 前缀的完整
  // 命令），缺省则复制 connectCommand——避免双写覆盖导致 cd 前缀丢失。
  // 业务副作用走 onCopied：落盘 scope/projectPath + 首次接入标记 has_onboarded
  // （后端只增不减；每次复制都带 true，幂等且能在配置被重置后自愈）。
  const copyConnect = (cmd?: string) => {
    const target = cmd ?? connectCommand;
    if (!target) return;
    copy("connect", target, {
      onCopied: () => {
        void invokeOrToast("save_config", {
          patch: { scope, projectPath: projectPath || null, hasOnboarded: true },
        });
      },
    });
  };

  const copyPerm = () => {
    if (permissionCommand) copy("perm", permissionCommand);
  };

  // 单选聚焦的开关语义：点开一块时其余收起，再点同一块收起。
  const toggleSection = (section: GuideSection) => {
    setExpanded((prev) => (prev === section ? null : section));
  };

  return {
    scope,
    setScope,
    projectPath,
    setProjectPath,
    includeShellTools,
    setIncludeShellTools,
    expanded,
    toggleSection,
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
