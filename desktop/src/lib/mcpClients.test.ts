import { describe, expect, it } from "vitest";
import {
  buildClientSnippet,
  buildMcpUrl,
  CLIENT_LABELS,
  CLIENT_VERIFY,
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

  it("https 形态 + 自签信任提示", () => {
    const s = buildClientSnippet("claude-code", { ...base, tls: true });
    expect(s.code).toContain("https://192.168.1.7:7823/mcp");
    expect(s.code).not.toContain("http://");
    expect(s.notes.join()).toContain("NODE_EXTRA_CA_CERTS");
  });
});

describe("buildClientSnippet · WorkBuddy / Codex / 通用", () => {
  it("WorkBuddy：mcpServers.url + headers 的 JSON，https 时附实测提示", () => {
    const s = buildClientSnippet("workbuddy", { ...base, tls: true });
    expect(s.kind).toBe("json");
    const parsed = JSON.parse(s.code);
    expect(parsed.mcpServers["cc-bridge"].url).toBe("https://192.168.1.7:7823/mcp");
    expect(parsed.mcpServers["cc-bridge"].headers.Authorization).toBe("Bearer tok-abc");
    expect(s.notes.join()).toContain("待实测");
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
