import { isWindows } from "./platform";

/**
 * 服务链路的状态判定（纯函数，与渲染分离以便单测）。
 *
 * 连接页要回答的唯一问题是「远程现在能不能连上来」。把它拆成三段，
 * 不只告诉用户通不通，还告诉他**卡在哪一环**：
 *
 *   本机服务 → 防火墙（仅 Windows）→ 远程调用
 *
 * 🔴 **一个必须守住的诚实线**：`remoteReachable` 是**本机发起的 TCP 探测**
 * （`status.rs` 里连自己的展示地址:port，超时 200ms）。它只能证明“地址已绑定、
 * 本机连得上”，**证明不了远程连得上**。所以它只能做第一段的副标题，
 * 绝不能拿去点亮第三段——那就是 `ConnectTab.tsx` 注释里已经警告过的那种假绿：
 * “诚实暴露本机探针对远程入站拦截的盲点——不再谎报绿色「已连接」”。
 *
 * 第三段用的是**无法伪造的证据**：`stats.totalRequests`——远程真的连上来调用过。
 */

/** 单段的视觉状态。 */
export type SegmentTone =
  /** 通。 */
  | "ok"
  /** 断，且已知原因。 */
  | "bad"
  /** 无法检测——**不得撞绿也不得报红**。 */
  | "unknown"
  /** 尚未发生 / 上游已断而无从判定。 */
  | "idle";

export interface ChainSegment {
  key: "service" | "firewall" | "remote";
  /** 段名，控制在 4 字内——窄卡里三段平分约 110px。 */
  name: string;
  tone: SegmentTone;
  /** 副标题，允许两行。 */
  detail: string;
}

/** 卡片整体基调，决定背景渐变。 */
export type ChainTone = "live" | "warn" | "error" | "stopped";

export interface ChainState {
  tone: ChainTone;
  segments: ChainSegment[];
  /** 主标题：一句话说清楚现在能不能用。 */
  headline: string;
  /** 副标题：下一步干啥，或为何是这个状态。 */
  sub: string;
}

export interface ChainInput {
  running: boolean;
  startupError: string | null;
  /** 本机探针：仅表达“地址已绑定”，见模块头注释。 */
  remoteReachable: boolean;
  platform: string | undefined;
  /** null / undefined = 无法检测（非 Windows 或 netsh 异常）。 */
  firewallPortOpen: boolean | null | undefined;
  /** false = 探测不可用（netsh 异常）。 */
  firewallAvailable: boolean | null | undefined;
  /** 本次运行累计请求数。进程内计数，重启归零。 */
  totalRequests: number;
  /** 本会话最近一次观测到新调用的壁钟；null = 未观测到。 */
  lastIncreaseAt: number | null;
  /** 当前壁钟，用于算“N 秒前”。显式传入以便单测。 */
  now: number;
  /** 监听端口。防火墙那段的文案要拿它拼，不能写死 7823（用户改得了）。 */
  port: number;
}

/** 把毫秒差说成人话。粒度就是 5s 轮询周期，不假装更精确。 */
function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.round(m / 60)} 小时前`;
}

/**
 * 第三段的副标题。
 *
 * 🔴 `lastIncreaseAt` 为 null 时**绝不能编一个时间**。这种情况真实存在：
 * 用户刚打开窗口（或刚从托盘恢复，序列因断层被清空），但服务已经跑了很久、
 * 远程也调用过很多次。此时只能陈述计数，不能声称“刚刚”。
 */
function remoteDetail(input: ChainInput): string {
  if (input.totalRequests <= 0) return "尚未发生";
  if (input.lastIncreaseAt == null) return `已调用 ${input.totalRequests.toLocaleString("en-US")} 次`;
  return agoText(input.now - input.lastIncreaseAt);
}

/**
 * 防火墙那一段是否要画。
 *
 * macOS 防火墙按应用授权、不拦本机监听端口的入站连接，后端根本不查
 * （`status.rs` 里非 Windows 直接返回 None）。画一个永远“未知”的段只会制造焦虑。
 */
export function showsFirewallSegment(platform: string | undefined): boolean {
  return isWindows(platform);
}

/** 由原始字段算出整条链路的展示状态。 */
export function computeChain(input: ChainInput): ChainState {
  const withFirewall = showsFirewallSegment(input.platform);

  // ── 启动失败：最严重，一上来就断在第一段 ──
  if (!input.running && input.startupError) {
    return {
      tone: "error",
      headline: "服务无法启动",
      sub: input.startupError,
      segments: [
        { key: "service", name: "本机服务", tone: "bad", detail: "启动失败" },
        ...(withFirewall
          ? [{ key: "firewall" as const, name: "防火墙", tone: "idle" as const, detail: "—" }]
          : []),
        { key: "remote", name: "远程调用", tone: "idle", detail: "—" },
      ],
    };
  }

  // ── 已停止 ──
  if (!input.running) {
    return {
      tone: "stopped",
      headline: "服务已停止，远程无法连接",
      sub: "配置与白名单均已保留，启动后立即恢复",
      segments: [
        { key: "service", name: "本机服务", tone: "idle", detail: "已停止" },
        ...(withFirewall
          ? [{ key: "firewall" as const, name: "防火墙", tone: "idle" as const, detail: "—" }]
          : []),
        { key: "remote", name: "远程调用", tone: "idle", detail: "—" },
      ],
    };
  }

  // ── 运行中：逐段判 ──
  const service: ChainSegment = {
    key: "service",
    name: "本机服务",
    tone: "ok",
    // remoteReachable 只能做到这一步：证明地址绑定了。不得冒充“远程可达”。
    detail: input.remoteReachable ? "运行中 · 地址已绑定" : "运行中",
  };

  const hasCalled = input.totalRequests > 0;
  const remote: ChainSegment = {
    key: "remote",
    name: "远程调用",
    tone: hasCalled ? "ok" : "idle",
    detail: remoteDetail(input),
  };

  if (!withFirewall) {
    return {
      tone: "live",
      headline: hasCalled ? "远程 Claude Code 可以正常调用" : "本机已就绪，等远程接入",
      sub: hasCalled
        ? `本次运行已调用 ${input.totalRequests.toLocaleString("en-US")} 次`
        : "把下方「接入 Claude Code」里的命令复制到远程执行即可",
      segments: [service, remote],
    };
  }

  // netsh 异常或查不到：显式“未知”。撞绿是谎报，报红是惊吓用户。
  const fwUnknown = input.firewallAvailable === false || input.firewallPortOpen == null;
  const fwOpen = input.firewallPortOpen === true;
  const firewall: ChainSegment = {
    key: "firewall",
    name: "防火墙",
    tone: fwUnknown ? "unknown" : fwOpen ? "ok" : "bad",
    detail: fwUnknown ? "无法检测" : fwOpen ? "已放行" : `${input.port}/TCP 未放行`,
  };

  // 防火墙明确没放行且远程确实从未调用过 → 高置信地指出卡在哪里。
  // 为何要加 `!hasCalled`：若远程已经调用成功过，那事实胜于探测——
  // 规则可能建在别的配置文件上，此时报“连不进来”是错的。
  if (!fwUnknown && !fwOpen && !hasCalled) {
    return {
      tone: "warn",
      headline: "远程连不进来：防火墙挡着",
      sub: "入站规则缺失，或只覆盖了部分网络配置文件",
      segments: [service, firewall, { ...remote, tone: "idle" }],
    };
  }

  return {
    tone: "live",
    headline: hasCalled ? "远程 Claude Code 可以正常调用" : "本机已就绪，等远程接入",
    sub: hasCalled
      ? fwUnknown
        ? "防火墙状态查不到，但远程已成功调用过，实际不影响"
        : `本次运行已调用 ${input.totalRequests.toLocaleString("en-US")} 次`
      : "把下方「接入 Claude Code」里的命令复制到远程执行即可",
    segments: [service, firewall, remote],
  };
}
