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

/** 自签兼容性标注（docs/client-compatibility.md 的 UI 摘要；实测推进后在此更新）。 */
export const CLIENT_SELFSIGNED: Record<McpClientTool, { level: "ok" | "untested"; note: string }> = {
  "claude-code": {
    level: "ok",
    note: "可通过 NODE_EXTRA_CA_CERTS 信任自签证书",
  },
  workbuddy: {
    level: "untested",
    note: "自签兼容性待实测；有域名时建议反代 + Let's Encrypt",
  },
  codex: {
    level: "untested",
    note: "自签兼容性待实测；有域名时建议反代 + Let's Encrypt",
  },
  generic: {
    level: "untested",
    note: "视工具的 TLS 策略而定",
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
    lines.push("注意：HTTPS 为自签证书，无法信任时告知用户先信任 cc-bridge.crt。");
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

  switch (tool) {
    case "claude-code": {
      // scope 沿用 lib/utils.ts 的 buildConnectCommand（在基础命令上替换补全）。
      const cmd = buildBaseCommand(input.host, input.port, input.token, input.transport, input.tls);
      if (input.tls) {
        notes.push(
          "自签证书需先信任：把桥导出的 cc-bridge.crt 保存到本地，并在启动 claude 前设置 NODE_EXTRA_CA_CERTS=证书路径",
        );
      }
      return { kind: "command", target: CLIENT_TARGETS[tool], code: cmd, notes };
    }
    case "workbuddy":
      if (input.tls) {
        notes.push(
          "WorkBuddy 对自签证书的信任策略待实测（见兼容性矩阵）；失败时优先改用反代 + Let's Encrypt",
        );
      }
      return {
        kind: "json",
        target: CLIENT_TARGETS[tool],
        code: JSON.stringify({ mcpServers: { "cc-bridge": { url, headers } } }, null, 2),
        notes,
      };
    case "codex": {
      if (input.transport === "sse") {
        notes.push(
          "Codex 仅支持 streamable HTTP（不支持 SSE），请在桥端连接设置切回 HTTP 传输后再接入",
        );
      }
      if (input.tls) {
        notes.push(
          "Codex 对自签证书的信任策略待实测（见兼容性矩阵）；失败时优先改用反代 + Let's Encrypt",
        );
      }
      // Streamable HTTP 形态（url + http_headers）。旧版本若报不支持远程服务器，
      // 需在 config.toml 顶层加 experimental_use_rmcp_client = true。
      const toml = [
        "[mcp_servers.cc-bridge]",
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
