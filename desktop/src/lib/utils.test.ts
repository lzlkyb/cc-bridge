/**
 * 命令拼接纯函数单元测试（④P2-9）。
 * 覆盖 lib/utils.ts 中"拼错一个字符就连不上"的高风险区：
 * buildDisplayHost / buildBaseCommand / buildConnectCommand / buildHealthCheck /
 * buildTokenSedCommand / buildPermissionGrantCommand。
 * 运行：npm run test（vitest run，仅开发期执行，不进产物）。
 */
import { describe, it, expect } from "vitest";
import {
  buildDisplayHost,
  buildBaseCommand,
  buildConnectCommand,
  buildHealthCheck,
  buildTokenSedCommand,
  buildPermissionGrantCommand,
} from "./utils";
import type { StatusResponse } from "./types";

/** 构造最小 StatusResponse（只有 host 参与被测逻辑，其余字段给安全默认值）。 */
function statusWithHost(host: string): StatusResponse {
  return { host } as unknown as StatusResponse;
}

describe("buildDisplayHost", () => {
  it("监听 0.0.0.0 时使用用户选中的 IP", () => {
    expect(buildDisplayHost(statusWithHost("0.0.0.0"), "192.168.1.5")).toBe("192.168.1.5");
  });

  it("监听 0.0.0.0 且未选中 IP 时回退 127.0.0.1", () => {
    expect(buildDisplayHost(statusWithHost("0.0.0.0"), "")).toBe("127.0.0.1");
  });

  it("监听具体地址时直接用配置的 host（忽略选中 IP）", () => {
    expect(buildDisplayHost(statusWithHost("10.0.0.8"), "192.168.1.5")).toBe("10.0.0.8");
  });

  it("status 未加载时返回空字符串", () => {
    expect(buildDisplayHost(undefined, "192.168.1.5")).toBe("");
  });
});

describe("buildBaseCommand", () => {
  it("默认 http transport：URL 以 /mcp 结尾且 Bearer 头完整", () => {
    const cmd = buildBaseCommand("192.168.1.5", 8848, "tok123");
    expect(cmd).toBe(
      'claude mcp add --transport http cc-bridge http://192.168.1.5:8848/mcp --header "Authorization: Bearer tok123"',
    );
  });

  it("sse transport：URL 以 /mcp/sse 结尾", () => {
    const cmd = buildBaseCommand("192.168.1.5", 8848, "tok123", "sse");
    expect(cmd).toContain("--transport sse");
    expect(cmd).toContain("http://192.168.1.5:8848/mcp/sse ");
  });

  it("Authorization 头保留双引号包裹（含空格不拆参）", () => {
    const cmd = buildBaseCommand("h", 1, "t");
    expect(cmd).toMatch(/--header "Authorization: Bearer t"$/);
  });
});

describe("buildConnectCommand", () => {
  const base = buildBaseCommand("127.0.0.1", 8848, "abc");

  it("user 作用域插入 --scope user", () => {
    const cmd = buildConnectCommand(base, "user");
    expect(cmd.startsWith("claude mcp add --scope user --transport http")).toBe(true);
  });

  it("project 作用域显式插入 --scope project（2026-07-13 修复回归）", () => {
    const cmd = buildConnectCommand(base, "project");
    expect(cmd.startsWith("claude mcp add --scope project --transport http")).toBe(true);
    // 不带 --scope 时 CLI 默认 local scope，与 UI 宣称的 .mcp.json 不一致——必须显式
    expect(cmd).toContain("--scope project");
  });

  it("只替换命令前缀，不影响 URL 与 token 部分", () => {
    const cmd = buildConnectCommand(base, "user");
    expect(cmd).toContain("http://127.0.0.1:8848/mcp");
    expect(cmd).toContain("Bearer abc");
  });
});

describe("buildHealthCheck", () => {
  it("拼出 curl 健康检查命令", () => {
    expect(buildHealthCheck("192.168.1.5", 8848)).toBe("curl http://192.168.1.5:8848/health");
  });
});

describe("buildTokenSedCommand", () => {
  it("oldToken 或 token 为空时返回空串（不生成半截命令）", () => {
    expect(buildTokenSedCommand("", "new", "user", "")).toBe("");
    expect(buildTokenSedCommand("old", "", "user", "")).toBe("");
  });

  it("user 作用域：目标 ~/.claude.json 且无 cd 前缀", () => {
    const cmd = buildTokenSedCommand("old", "new", "user", "");
    expect(cmd).toBe("sed -i 's#Bearer old#Bearer new#g' ~/.claude.json");
  });

  it("project 作用域 + 项目路径：cd 加双引号（含空格路径不拆参）", () => {
    const cmd = buildTokenSedCommand("old", "new", "project", "C:\\My Project\\app");
    expect(cmd.startsWith('cd "C:\\My Project\\app" && ')).toBe(true);
    expect(cmd).toContain(".mcp.json");
    expect(cmd).not.toContain("~/.claude.json");
  });

  it("project 作用域但路径为空/空白：不加 cd 前缀", () => {
    const cmd = buildTokenSedCommand("old", "new", "project", "   ");
    expect(cmd.startsWith("sed -i")).toBe(true);
  });

  it("路径首尾空白被 trim 后再包引号", () => {
    const cmd = buildTokenSedCommand("old", "new", "project", "  /srv/app  ");
    expect(cmd.startsWith('cd "/srv/app" && ')).toBe(true);
  });
});

describe("buildPermissionGrantCommand", () => {
  it("user 作用域：目标 ~/.claude/settings.json 且无 cd 前缀", () => {
    const cmd = buildPermissionGrantCommand("user", "", false);
    expect(cmd.startsWith("python3 -c")).toBe(true);
    expect(cmd).toContain("~/.claude/settings.json");
  });

  it("project 作用域：目标 .claude/settings.local.json 且 cd 路径加双引号", () => {
    const cmd = buildPermissionGrantCommand("project", "C:\\My Project\\app", false);
    expect(cmd.startsWith('cd "C:\\My Project\\app" && python3 -c')).toBe(true);
    expect(cmd).toContain(".claude/settings.local.json");
    expect(cmd).not.toContain("~/.claude/settings.json");
  });

  it("不含命令执行工具时：逐条列出 14 个文件/列表类工具，且不含 run_command", () => {
    const cmd = buildPermissionGrantCommand("user", "", false);
    expect(cmd).toContain("'read_files'");
    expect(cmd).toContain("'search_files'");
    expect(cmd).toContain("'notebook_edit'");
    expect(cmd).not.toContain("run_command");
    expect(cmd).not.toContain("mcp__cc-bridge__*");
    // 14 个工具一个不少
    const toolCount = (cmd.match(/'[a-z_]+'/g) ?? []).filter((t) =>
      /^'(list_allowed_roots|list_directory|read_files|write_files|edit_files|create_directory|remove_directory|delete_files|move_files|copy_files|search_files|batch|notebook_edit|analyze_file)'$/.test(
        t,
      ),
    ).length;
    expect(toolCount).toBe(14);
  });

  it("含命令执行工具时：改用 mcp__cc-bridge__* 通配符单条规则", () => {
    const cmd = buildPermissionGrantCommand("user", "", true);
    expect(cmd).toContain("mcp__cc-bridge__*");
    expect(cmd).not.toContain("'read_files'");
  });

  it("始终写入 enableAllProjectMcpServers 与 enabledMcpjsonServers", () => {
    const cmd = buildPermissionGrantCommand("user", "", true);
    expect(cmd).toContain("d['enableAllProjectMcpServers'] = True");
    expect(cmd).toContain("'cc-bridge' not in servers");
  });
});
