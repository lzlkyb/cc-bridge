import { describe, expect, it } from "vitest";
import {
  buildClientSnippet,
  buildMcpUrl,
  CLIENT_LABELS,
  CLIENT_SELFSIGNED,
  CLIENT_VERIFY,
  SELFSIGNED_BADGE,
  type CopySeg,
  type SnippetInput,
} from "./mcpClients";

const base: SnippetInput = {
  host: "192.168.1.7",
  port: 7823,
  token: "tok-abc",
  transport: "http",
  tls: false,
};

describe("buildMcpUrl", () => {
  it("http 传输拼 /mcp，sse 拼 /mcp/sse", () => {
    expect(buildMcpUrl({ ...base })).toBe("http://192.168.1.7:7823/mcp");
    expect(buildMcpUrl({ ...base, transport: "sse" })).toBe("http://192.168.1.7:7823/mcp/sse");
  });

  it("tls 开启时前缀切 https（路径不变）", () => {
    expect(buildMcpUrl({ ...base, tls: true })).toBe("https://192.168.1.7:7823/mcp");
    expect(buildMcpUrl({ ...base, tls: true, transport: "sse" })).toBe(
      "https://192.168.1.7:7823/mcp/sse",
    );
  });
});

describe("buildClientSnippet · claude-code", () => {
  it("http 形态与旧 buildBaseCommand 一致（无 scope）", () => {
    const s = buildClientSnippet("claude-code", base);
    expect(s.kind).toBe("command");
    expect(s.code).toBe(
      'claude mcp add --transport http cc-bridge http://192.168.1.7:7823/mcp --header "Authorization: Bearer tok-abc"',
    );
    expect(s.notes).toHaveLength(0);
  });

  it("https 形态切 https，且片段不再塞自签 note（信任指引归 CLIENT_SELFSIGNED）", () => {
    const s = buildClientSnippet("claude-code", { ...base, tls: true });
    expect(s.code).toContain("https://192.168.1.7:7823/mcp");
    expect(s.code).not.toContain("http://");
    expect(s.notes).toHaveLength(0);
  });
});

describe("buildClientSnippet · WorkBuddy / Codex / 通用", () => {
  it("WorkBuddy：mcpServers.url + headers 的 JSON（自签 note 归 CLIENT_SELFSIGNED）", () => {
    const s = buildClientSnippet("workbuddy", { ...base, tls: true });
    expect(s.kind).toBe("json");
    const parsed = JSON.parse(s.code);
    expect(parsed.mcpServers["cc-bridge"].url).toBe("https://192.168.1.7:7823/mcp");
    expect(parsed.mcpServers["cc-bridge"].headers.Authorization).toBe("Bearer tok-abc");
    expect(s.notes).toHaveLength(0);
  });

  it("Codex：[mcp_servers.*] TOML 形态，url + http_headers", () => {
    const s = buildClientSnippet("codex", base);
    expect(s.kind).toBe("toml");
    expect(s.code).toContain("[mcp_servers.cc-bridge]");
    expect(s.code).toContain('url = "http://192.168.1.7:7823/mcp"');
    expect(s.code).toContain('http_headers = { Authorization = "Bearer tok-abc" }');
    expect(s.notes).toHaveLength(0);
  });

  it("Codex：SSE 传输时提示仅支持 streamable HTTP", () => {
    const s = buildClientSnippet("codex", { ...base, transport: "sse" });
    expect(s.notes.join()).toContain("不支持 SSE");
  });

  it("通用：裸 url + headers + transport 标注", () => {
    const s = buildClientSnippet("generic", base);
    const parsed = JSON.parse(s.code);
    expect(parsed.url).toBe("http://192.168.1.7:7823/mcp");
    expect(parsed.transport).toBe("streamable-http");
    expect(parsed.headers.Authorization).toBe("Bearer tok-abc");
  });
});

describe("常量表完整性", () => {
  it("四种工具都有显示名/载体/验证方式/自签标注", () => {
    for (const t of ["claude-code", "workbuddy", "codex", "generic"] as const) {
      expect(CLIENT_LABELS[t]).toBeTruthy();
      expect(buildClientSnippet(t, base).target).toBeTruthy();
      expect(CLIENT_VERIFY[t]).toBeTruthy();
    }
  });
});

const TOOLS = ["claude-code", "workbuddy", "codex", "generic"] as const;

/** 取出片段数组里的环境变量 chip（徽章行/信任步骤的「做法」载体）。 */
function envVars(segs: CopySeg[]): string[] {
  return segs.filter((s): s is { env: string } => typeof s !== "string").map((s) => s.env);
}

describe("CLIENT_SELFSIGNED · 三态数据模型", () => {
  it("四种工具都有合法 level / 非空 note / 非空 steps / 布尔 verified", () => {
    for (const t of TOOLS) {
      const s = CLIENT_SELFSIGNED[t];
      expect(["ok", "setup", "unsupported"]).toContain(s.level);
      expect(s.note.length).toBeGreaterThan(0);
      expect(s.steps.length).toBeGreaterThan(0);
      expect(typeof s.verified).toBe("boolean");
    }
  });

  it("只有 Claude Code 是已实测的 ok，其余为未实测的 setup", () => {
    expect(CLIENT_SELFSIGNED["claude-code"].level).toBe("ok");
    expect(CLIENT_SELFSIGNED["claude-code"].verified).toBe(true);
    for (const t of ["workbuddy", "codex", "generic"] as const) {
      expect(CLIENT_SELFSIGNED[t].level).toBe("setup");
      expect(CLIENT_SELFSIGNED[t].verified).toBe(false);
    }
  });

  it("每家的 note 与每条信任步骤都嵌了环境变量 chip（否则给不出做法）", () => {
    for (const t of TOOLS) {
      const s = CLIENT_SELFSIGNED[t];
      expect(envVars(s.note).length).toBeGreaterThan(0);
      for (const step of s.steps) {
        expect(step.length).toBeGreaterThan(0);
      }
      // 至少有一条步骤带环境变量（第一步是「导出证书」，所以看整体）
      expect(s.steps.flatMap(envVars).length).toBeGreaterThan(0);
    }
  });

  it("Codex 的信任变量按官方优先级：CODEX_CA_CERTIFICATE → SSL_CERT_FILE", () => {
    expect(envVars(CLIENT_SELFSIGNED.codex.note)).toEqual([
      "CODEX_CA_CERTIFICATE",
      "SSL_CERT_FILE",
    ]);
    expect(envVars(CLIENT_SELFSIGNED.codex.steps[1])).toEqual([
      "CODEX_CA_CERTIFICATE=/path/cc-bridge.crt",
    ]);
  });

  it("Claude Code / WorkBuddy 都走 NODE_EXTRA_CA_CERTS", () => {
    expect(envVars(CLIENT_SELFSIGNED["claude-code"].note)).toEqual(["NODE_EXTRA_CA_CERTS"]);
    expect(envVars(CLIENT_SELFSIGNED.workbuddy.note)).toEqual(["NODE_EXTRA_CA_CERTS"]);
  });

  it("generic 同时给出 Node 系与 Rust 系两条路（免得只说一半）", () => {
    expect(envVars(CLIENT_SELFSIGNED.generic.note)).toEqual([
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
    ]);
  });
});

describe("SELFSIGNED_BADGE · 三态展示映射", () => {
  it("三态都有标签与图标（unsupported 先建好，等实测回填实例）", () => {
    expect(SELFSIGNED_BADGE.ok.label).toBe("可信任");
    expect(SELFSIGNED_BADGE.setup.label).toBe("需额外步骤");
    expect(SELFSIGNED_BADGE.unsupported.label).toBe("不支持自签");
    for (const lvl of ["ok", "setup", "unsupported"] as const) {
      expect(SELFSIGNED_BADGE[lvl].icon).toBeTruthy();
    }
  });

  it("徽章文字色一律用 -ink 变体（基础色 10px × 12% 淡底不达 WCAG AA）", () => {
    expect(SELFSIGNED_BADGE.ok.className).toContain("text-success-ink");
    expect(SELFSIGNED_BADGE.setup.className).toContain("text-warning-ink");
    expect(SELFSIGNED_BADGE.unsupported.className).toContain("text-destructive-ink");
  });
});
