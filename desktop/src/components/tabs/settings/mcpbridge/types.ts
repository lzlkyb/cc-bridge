/**
 * 外挂 MCP 桥的前端类型。
 *
 * 放在本目录而不是 `lib/types.ts`：只有这张卡用得到，而 `lib/types.ts` 已经是全局
 * 共享类型的大篐子了。
 *
 * 🔴 注意只有 `envKeys` 而没有 `env`——后端根本不传值（S7）。
 * 想在前端回显密钥是做不到的，这是故意的。
 */

/** 服务状态。全部可由**不启进程**的信息算出来。 */
export type ServerState = "ready" | "stale" | "unknown" | "not_installed" | "failed";

/**
 * 工具的紧凑形式：名字 + 一句话。
 *
 * **没有 `inputSchema`**——后端的 `compact_index` 就不给。界面只需回答
 * “这东西能干什么”，完整 schema 是给模型看的。
 */
export interface McpTool {
  name: string;
  summary: string;
}

export interface McpBridgeServer {
  name: string;
  transport: string;
  /** 原样展示，不解析、不高亮其中片段（S0/S5）。 */
  command: string;
  args: string[];
  envKeys: string[];
  cwd: string | null;
  /** `cwd` 为空时实际生效的目录（后端算好传下来）。 */
  effectiveCwd?: string | null;
  enabled: boolean;
  state: ServerState;
  toolCount: number;
  /** Unix 秒。 */
  fetchedAt?: number;
  /** 失败原文。不改写成「启动失败」这种没信息量的话。 */
  error?: string;
  /**
   * 是否允许远程按调用指定工作目录（多项目支持）。
   *
   * 这是本特性里唯一放宽边界的开关：关着时 cwd 由本机管理员定死，
   * 开了之后由远程在白名单根目录内挑。
   */
  allowRemoteCwd: boolean;
  /** 当前活着的实例（各自的工作目录）。不展示的话，用户不知道自己开了几个进程。 */
  liveCwds: string[];
  /** 工具清单。没探测过时为空数组——不会为了填它去启进程。 */
  tools: McpTool[];
  /** server 自己给的说明。MCP 的**可选**字段，很多 server 没有。 */
  instructions?: string;
}

export interface McpBridgeList {
  enabled: boolean;
  servers: McpBridgeServer[];
}

/** 导入候选。`state` 不是 `importable` 时列出但置灰，**不静默丢掉**。
 *
 * `already_imported` = 设置页里已有一模一样的一条（同名 + 同配置）。
 * 它与「重名」不同：同名但配置不同的仍是 `importable`，只是带上 `renamedFrom`。
 */
export interface McpBridgeCandidate {
  name: string;
  transport: string;
  command: string;
  args: string[];
  envKeys: string[];
  cwd: string | null;
  source: string;
  state: "importable" | "already_imported" | "unavailable";
  reason: string | null;
  /** 同名避让后的原名，有才传。 */
  renamedFrom?: string;
  /**
   * 工具清单。扫描本身是**零进程**的，所以它只在两种情况下非空：
   * 用户点过「运行一下」，或之前跑过且指纹未变（后端从 manifest 带出来）。
   */
  tools?: McpTool[];
  toolCount?: number;
  instructions?: string;
}

/** 导入向导里「运行一下」的返回。 */
export interface McpBridgeInspect {
  state: "ready" | "failed";
  toolCount: number;
  tools: McpTool[];
  instructions?: string;
  /** 失败原文 + 对方 stderr。不改写。 */
  error?: string;
}

export interface McpBridgeScan {
  candidates: McpBridgeCandidate[];
  sources: string[];
}

export interface McpBridgeProbe {
  state: "ready" | "failed";
  toolCount: number;
  error?: string;
}

/** 提交给 `mcp_bridge_upsert` 的形状。**没有 `enabled`**：启用另走一条命令。 */
export interface ServerInput {
  name: string;
  transport?: string;
  command: string;
  args: string[];
  /**
   * `null` = 保持现有不变，`[]` = 清空。
   *
   * 两者必须分开：前端拿不到现有的 env **值**（只有键名，S7），
   * 若把“没填”当成“清空”，用户改一下参数就会静默把 API key 弄没。
   */
  env: [string, string][] | null;
  cwd: string | null;
}

/** 把 command + args 拼成一行展示。参数含空格时加引号，否则看不出边界。 */
export function fullCommand(command: string, args: string[]): string {
  const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
  return [command, ...quoted].join(" ");
}
