import { buildBaseCommand } from "./utils";

/**
 * P2 多工具接入层：按 MCP client 生成接入配置片段。
 *
 * MCP 是开放协议——桥端零改动，差别只在各工具的配置载体：
 * - Claude Code：CLI 命令（claude mcp add）
 * - WorkBuddy：~/.workbuddy/mcp.json（mcpServers.url + headers 形态）
 * - Codex：~/.codex/config.toml（[mcp_servers.*] TOML 形态，仅支持 streamable HTTP）
 * - generic：裸 URL + header，给任何支持 Streamable HTTP 的工具
 *
 * 纯函数层（R11）：不碰 React、不碰 invoke，host/port/token 全部由调用方传入。
 */

export type McpClientTool = "claude-code" | "workbuddy" | "codex" | "generic";

/** 接入目标参数（displayHost 已含 IP 选择逻辑，见 buildDisplayHost）。 */
export interface SnippetInput {
  host: string;
  port: number;
  token: string;
  transport: "http" | "sse";
  /** P1 HTTPS 远程访问开关状态（get_tls_status.enabled）。 */
  tls: boolean;
  /**
   * 多设备模式（opt-in，批3-2）：本机身份尾号（4 位 hex）。
   * 非空时 WorkBuddy/Codex 手动片段的条目名带尾号（cc-bridge-<id>，与其它设备
   * 并存互不覆盖）；空/缺省 = 条目名维持 cc-bridge（兼容性契约，逐字与旧版一致）。
   * 🔴 条目名拼装语义与 Rust `network::entry_name` 一致（双端各一份，改一处同步另一处）。
   */
  deviceId?: string;
}

/** MCP 端点 URL（SSE 传输带 /mcp/sse 后缀）。 */
export function buildMcpUrl(input: Pick<SnippetInput, "host" | "port" | "transport" | "tls">): string {
  const suffix = input.transport === "sse" ? "/mcp/sse" : "/mcp";
  return `${input.tls ? "https" : "http"}://${input.host}:${input.port}${suffix}`;
}

/** 工具显示名（向导选择器与标题用）。 */
export const CLIENT_LABELS: Record<McpClientTool, string> = {
  "claude-code": "Claude Code",
  workbuddy: "WorkBuddy",
  codex: "Codex",
  generic: "通用 MCP 工具",
};

/** 各工具的配置载体说明（步骤文案第一行用）。 */
export const CLIENT_TARGETS: Record<McpClientTool, string> = {
  "claude-code": "终端执行 CLI 命令",
  workbuddy: "写入 ~/.workbuddy/mcp.json",
  codex: "写入 ~/.codex/config.toml",
  generic: "按工具的 MCP 设置界面填写",
};

/** 接入完成后的验证方式提示（步骤文案最后一步用）。 */
export const CLIENT_VERIFY: Record<McpClientTool, string> = {
  "claude-code": "任意项目启动 claude，/mcp 显示 cc-bridge 已连接",
  workbuddy: "重启 WorkBuddy，连接器管理出现 cc-bridge 即成功",
  codex: "重启 Codex 后执行 codex mcp list，cc-bridge 就绪即成功",
  generic: "在工具的 MCP 设置里确认 cc-bridge 显示已连接",
};

/**
 * 自签兼容性等级（接入向导徽章三态）。
 * - `ok`：已确认可信任（有明确、已验证的信任路径）
 * - `setup`：可信任，但需手动信任证书（设环境变量 / 导入根证书）
 * - `unsupported`：确认无法信任自签 → 只能反代 + Let's Encrypt（**暂无实例**，由 P0-3 真机实测回填）
 */
export type SelfSignedLevel = "ok" | "setup" | "unsupported";

/**
 * 文案片段：字符串按普通文本渲染，`{ env }` 渲染为等宽 chip。
 *
 * WHY 用片段数组而不是「模板字符串 + 占位符替换」：generic 的一句话里要出现两个
 * **不同**的环境变量，占位符方案要么退化成 `{env0}`/`{env1}`，要么得再切一次字符串；
 * 片段数组直接、可类型检查，多个变量也不用特例。
 */
export type CopySeg = string | { env: string };

/** 单条信任步骤（片段数组，便于在步骤正文里嵌环境变量 chip）。 */
export type CopyStep = CopySeg[];

export interface SelfSignedInfo {
  level: SelfSignedLevel;
  /** 一句话结论（徽章行正文，可嵌 `{ env }` chip）。 */
  note: CopySeg[];
  /** 信任步骤（`CertPemStep` 的「信任步骤」有序列表）。 */
  steps: CopyStep[];
  /** `true` = 已真机实测；`false` = 仅文档依据，UI 追加「文档依据 · 待实测」小标签。 */
  verified: boolean;
}

/** 三态徽章的展示映射（纯数据放在 lib，便于单测；组件只做渲染）。 */
export const SELFSIGNED_BADGE: Record<
  SelfSignedLevel,
  { label: string; className: string; icon: string }
> = {
  ok: { label: "可信任", className: "bg-success/12 text-success-ink", icon: "check" },
  setup: { label: "需额外步骤", className: "bg-warning/12 text-warning-ink", icon: "alertTriangle" },
  unsupported: {
    label: "不支持自签",
    className: "bg-destructive/10 text-destructive-ink",
    icon: "close",
  },
};

/**
 * 自签兼容性标注（`docs/client-compatibility.md` 的 UI 摘要；实测推进后**两处同步更新**）。
 *
 * - 徽章行的文字色用 `-ink` 变体（比 `-foreground`/基础色深）：10px 字号 + 12% 淡底上，
 *   基础 `--success hsl(142 71% 45%)` 在白底只有 ≈2.6:1，不达 WCAG AA，详见 index.css 注释。
 * - 整块只在 HTTPS 远程访问开启时渲染（显示条件见 ToolGuide 的 `tlsEnabled` 守卫）。
 */
export const CLIENT_SELFSIGNED: Record<McpClientTool, SelfSignedInfo> = {
  "claude-code": {
    level: "ok",
    verified: true,
    note: [
      "启动 claude 前设 ",
      { env: "NODE_EXTRA_CA_CERTS" },
      " 指向导出的 cc-bridge.crt 即可。",
    ],
    steps: [
      ["导出 cc-bridge.crt 到本地（下方按钮）"],
      ["启动前导出环境变量：", { env: "NODE_EXTRA_CA_CERTS=/path/cc-bridge.crt" }],
    ],
  },
  workbuddy: {
    level: "setup",
    verified: false,
    note: ["运行在 Node 上，认 ", { env: "NODE_EXTRA_CA_CERTS" }, " 指向 cc-bridge.crt。"],
    steps: [
      ["导出 cc-bridge.crt 到本地（下方按钮）"],
      ["以该环境变量启动 WorkBuddy：", { env: "NODE_EXTRA_CA_CERTS=/path/cc-bridge.crt" }],
    ],
  },
  codex: {
    level: "setup",
    verified: false,
    note: [
      "Codex 会校验证书；设 ",
      { env: "CODEX_CA_CERTIFICATE" },
      " 指向 cc-bridge.crt（未设时回退 ",
      { env: "SSL_CERT_FILE" },
      "，再回退系统根证书）。",
    ],
    steps: [
      ["导出 cc-bridge.crt 到本地（下方按钮）"],
      ["启动前导出环境变量：", { env: "CODEX_CA_CERTIFICATE=/path/cc-bridge.crt" }],
    ],
  },
  generic: {
    level: "setup",
    verified: false,
    note: [
      "Node 类工具认 ",
      { env: "NODE_EXTRA_CA_CERTS" },
      "；Rust 类工具常认 ",
      { env: "SSL_CERT_FILE" },
      " 或系统根证书。无法信任时改用反向代理 + Let's Encrypt。",
    ],
    steps: [
      ["导出 cc-bridge.crt 到本地（下方按钮）"],
      [
        "按工具的 TLS 策略导入该证书（Node 系设 ",
        { env: "NODE_EXTRA_CA_CERTS" },
        "，Rust 系设 ",
        { env: "SSL_CERT_FILE" },
        "）",
      ],
    ],
  },
};

/**
 * 通用工具的「复制给 AI 代接入」提示词（精简版：AI 自己懂 MCP，只给事实不给教程）。
 * URL / token / 备用端点 / TLS 注意事项动态内嵌（与片段同策略：本机配置不脱敏）。
 */
export function buildGenericPrompt(input: SnippetInput): string {
  const url = buildMcpUrl(input);
  const altUrl = buildMcpUrl({ ...input, transport: input.transport === "sse" ? "http" : "sse" });
  const mainTransport = input.transport === "sse" ? "SSE" : "Streamable HTTP";
  const altTransport = input.transport === "sse" ? "Streamable HTTP" : "SSE";

  const lines: string[] = [
    "请把我接入 MCP 服务器 cc-bridge：",
    `- 端点：${url}（${mainTransport}；若你不支持，改用${altTransport}：${altUrl}）`,
    `- 认证：请求头 Authorization: Bearer ${input.token}`,
    "",
    "按你自己的配置方式接入并验证，完成后告诉我结果。",
  ];
  if (input.tls) {
    lines.push(
      "注意：HTTPS 为自签证书；无法信任时先让用户信任 cc-bridge.crt（Node 系设 NODE_EXTRA_CA_CERTS，Rust 系设 SSL_CERT_FILE 或导入系统根证书）。",
    );
  }
  return lines.join("\n");
}

export interface ClientSnippet {
  /** 展示形态：命令块 / JSON 块 / TOML 块（向导据此选渲染组件）。 */
  kind: "command" | "json" | "toml";
  /** 配置载体提示（CLIENT_TARGETS）。 */
  target: string;
  code: string;
  /** HTTPS 自签场景的附加步骤（信任证书）。 */
  notes: string[];
}

/**
 * 按工具生成接入片段。token 直接内嵌（与现有 claude 命令一致）——
 * 这是用户本机自己的配置文件，不额外脱敏。
 */
export function buildClientSnippet(tool: McpClientTool, input: SnippetInput): ClientSnippet {
  const url = buildMcpUrl(input);
  const headers = { Authorization: `Bearer ${input.token}` };
  const notes: string[] = [];
  // 多设备条目名（批3-2）：尾号非空才带（语义对齐 Rust network::entry_name）。
  const entry = input.deviceId ? `cc-bridge-${input.deviceId}` : "cc-bridge";

  switch (tool) {
    case "claude-code": {
      // scope 沿用 lib/utils.ts 的 buildConnectCommand（在基础命令上替换补全）。
      // 自签信任指引不在这里出：统一由 CLIENT_SELFSIGNED["claude-code"] 承载
      // （徽章行 note + CertPemStep 的信任步骤），避免同一件事在片段 note 里再说一遍。
      const cmd = buildBaseCommand(input.host, input.port, input.token, input.transport, input.tls);
      return { kind: "command", target: CLIENT_TARGETS[tool], code: cmd, notes };
    }
    case "workbuddy":
      // 同上：自签信任指引归 CLIENT_SELFSIGNED.workbuddy（env = NODE_EXTRA_CA_CERTS）。
      return {
        kind: "json",
        target: CLIENT_TARGETS[tool],
        code: JSON.stringify({ mcpServers: { [entry]: { url, headers } } }, null, 2),
        notes,
      };
    case "codex": {
      if (input.transport === "sse") {
        notes.push(
          "Codex 仅支持 streamable HTTP（不支持 SSE），请在桥端连接设置切回 HTTP 传输后再接入",
        );
      }
      // 自签信任指引归 CLIENT_SELFSIGNED.codex（env = CODEX_CA_CERTIFICATE → SSL_CERT_FILE → 系统根证书）。
      // Streamable HTTP 形态（url + http_headers）。旧版本若报不支持远程服务器，
      // 需在 config.toml 顶层加 experimental_use_rmcp_client = true。
      const toml = [
        `[mcp_servers.${entry}]`,
        `url = "${url}"`,
        `http_headers = { Authorization = "Bearer ${input.token}" }`,
      ].join("\n");
      return { kind: "toml", target: CLIENT_TARGETS[tool], code: toml, notes };
    }
    case "generic":
      return {
        kind: "json",
        target: CLIENT_TARGETS[tool],
        code: JSON.stringify(
          {
            url,
            headers,
            transport: input.transport === "sse" ? "sse" : "streamable-http",
          },
          null,
          2,
        ),
        notes,
      };
  }
}
