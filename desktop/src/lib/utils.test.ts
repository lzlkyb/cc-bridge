/**
 * 命令拼接纯函数单元测试（④P2-9）。
 * 覆盖 lib/utils.ts 中"拼错一个字符就连不上"的高风险区：
 * buildDisplayHost / buildBaseCommand / buildConnectCommand / buildHealthCheck /
 * buildTokenSedCommand / buildPermissionGrantCommand。
 * 运行：npm run test（vitest run，仅开发期执行，不进产物）。
 */
import { describe, it, expect } from "vitest";
import { globMatch } from "./utils";
import {
  buildDisplayHost,
  buildBaseCommand,
  buildConnectCommand,
  buildHealthCheck,
  buildIpSedCommand,
  buildMultiDeviceCommand,
  buildTokenSedCommand,
  buildPermissionGrantCommand,
  formatUptime,
  fmtTokens,
  shortDateKey,
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

  it("tls 开启时切 https 并加 -k（自签证书）", () => {
    expect(buildHealthCheck("192.168.1.5", 8848, true)).toBe(
      "curl -k https://192.168.1.5:8848/health",
    );
  });
});

describe("buildIpSedCommand", () => {
  it("http 模式：匹配段兼容 http/https 旧值，替换目标为 http", () => {
    expect(buildIpSedCommand("10.0.0.8", 7823, "user", "")).toBe(
      "sed -i 's#https\\?://[0-9.]*:7823/mcp#http://10.0.0.8:7823/mcp#g' ~/.claude.json",
    );
  });

  it("tls 模式：替换目标切 https", () => {
    expect(buildIpSedCommand("10.0.0.8", 7823, "user", "", true)).toBe(
      "sed -i 's#https\\?://[0-9.]*:7823/mcp#https://10.0.0.8:7823/mcp#g' ~/.claude.json",
    );
  });

  it("project 作用域：配置文件指 .mcp.json，带项目路径时拼 cd 前缀", () => {
    expect(buildIpSedCommand("10.0.0.8", 7823, "project", "/home/u/app")).toBe(
      "cd \"/home/u/app\" && sed -i 's#https\\?://[0-9.]*:7823/mcp#http://10.0.0.8:7823/mcp#g' .mcp.json",
    );
  });

  it("selectedIp 为空返回空串（不生成半截命令）", () => {
    expect(buildIpSedCommand("", 7823, "user", "")).toBe("");
  });
});

describe("buildMultiDeviceCommand", () => {
  it("条目级 remove+add：条目名带 deviceId、固定 user 级、token 内联", () => {
    expect(buildMultiDeviceCommand("10.0.0.8", 7823, "tok", "http", false, "a3f2")).toBe(
      'claude mcp remove cc-bridge-a3f2 2>/dev/null\nclaude mcp add cc-bridge-a3f2 -s user --transport http --header "Authorization: Bearer tok" http://10.0.0.8:7823/mcp',
    );
  });

  it("sse + tls：URL 后缀与 --transport 跟随，scheme 切 https", () => {
    const cmd = buildMultiDeviceCommand("10.0.0.8", 7823, "tok", "sse", true, "b7c1");
    expect(cmd).toContain("--transport sse");
    expect(cmd).toContain("https://10.0.0.8:7823/mcp/sse");
  });

  it("deviceId 为空返回空串（宁可空也不出坏命令）", () => {
    expect(buildMultiDeviceCommand("10.0.0.8", 7823, "tok", "http", false, "")).toBe("");
  });
});

describe("buildIpSedCommand · 多设备 scoped（批3-2）", () => {
  it("codex：地址范围锚定 TOML 段头，只替换本条目块（与 Rust build_scoped_sed_command 逐字一致）", () => {
    expect(buildIpSedCommand("10.0.0.8", 7823, "user", "", false, "codex", "a3f2")).toBe(
      "sed -i '/^\\[mcp_servers\\.cc-bridge-a3f2\\]/,/^\\[/ s#https\\?://[0-9.]*:7823/mcp#http://10.0.0.8:7823/mcp#g' ~/.codex/config.toml",
    );
  });

  it("workbuddy：地址范围锚定 JSON 条目键到 Authorization 行", () => {
    expect(buildIpSedCommand("10.0.0.8", 7823, "user", "", true, "workbuddy", "b7c1")).toBe(
      "sed -i '/\"cc-bridge-b7c1\": \\{/,/\"Authorization\"/ s#https\\?://[0-9.]*:7823/mcp#https://10.0.0.8:7823/mcp#g' ~/.workbuddy/mcp.json",
    );
  });

  it("claude-code 不走 scoped（它有条目级 CLI）：传 deviceId 也维持全局 sed", () => {
    expect(buildIpSedCommand("10.0.0.8", 7823, "user", "", false, "claude-code", "a3f2")).toBe(
      "sed -i 's#https\\?://[0-9.]*:7823/mcp#http://10.0.0.8:7823/mcp#g' ~/.claude.json",
    );
  });

  it("deviceId 为空时 codex/workbuddy 维持全局 sed（兼容性契约）", () => {
    expect(buildIpSedCommand("10.0.0.8", 7823, "user", "", false, "codex")).toBe(
      "sed -i 's#https\\?://[0-9.]*:7823/mcp#http://10.0.0.8:7823/mcp#g' ~/.codex/config.toml",
    );
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

describe("formatUptime（中文时长）", () => {
  it("不足一分钟给到秒（刚启动时能看到跳）", () => {
    expect(formatUptime(0)).toBe("0秒");
    expect(formatUptime(45)).toBe("45秒");
  });

  it("分钟级给「X分Y秒」", () => {
    expect(formatUptime(60)).toBe("1分0秒");
    expect(formatUptime(125)).toBe("2分5秒");
  });

  it("小时级只给两级：「X小时Y分」，不再带秒", () => {
    expect(formatUptime(3600)).toBe("1小时0分");
    expect(formatUptime(3600 + 22 * 60 + 13)).toBe("1小时22分");
  });

  it("超过一天进位到「X天Y小时」", () => {
    expect(formatUptime(86400)).toBe("1天0小时");
    expect(formatUptime(3 * 86400 + 14 * 3600 + 59 * 60)).toBe("3天14小时");
  });

  it("负数与小数不产生怪值", () => {
    expect(formatUptime(-5)).toBe("0秒");
    expect(formatUptime(45.9)).toBe("45秒");
  });
});

describe("fmtTokens（估算用量格式化）", () => {
  it("万以下给千分位原值", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(9999)).toBe("9,999");
  });

  it("万级保留 1 位小数并去尾随 0", () => {
    expect(fmtTokens(842000)).toBe("84.2万");
    expect(fmtTokens(10000)).toBe("1万");
    expect(fmtTokens(100500)).toBe("10.1万");
  });

  it("百万级不再带小数（避免数字过长的视觉噪声）", () => {
    expect(fmtTokens(1234500)).toBe("123万");
  });
});

describe("shortDateKey（日期键短标签）", () => {
  it("去前导零转斜杠格式", () => {
    expect(shortDateKey("2026-09-27")).toBe("9/27");
    expect(shortDateKey("2026-12-05")).toBe("12/5");
  });

  it("非法输入原样返回（容错不抛错）", () => {
    expect(shortDateKey("今天")).toBe("今天");
    expect(shortDateKey("")).toBe("");
  });
});

/* ─── globMatch（白名单排除规则，与 Rust path.rs 同语义）─── */


describe("globMatch 排除规则匹配", () => {
  it("** 跨层（含零层）", () => {
    expect(globMatch("src/**/x.ts", "src/x.ts")).toBe(true);
    expect(globMatch("src/**/x.ts", "src/a/b/x.ts")).toBe(true);
    expect(globMatch("build/**", "build")).toBe(true);
    expect(globMatch("build/**", "build/a/b/c.obj")).toBe(true);
    expect(globMatch("build/**", "builder/a")).toBe(false);
  });

  it("* 不跨层、? 单字符", () => {
    expect(globMatch("logs/*.log", "logs/app.log")).toBe(true);
    expect(globMatch("logs/*.log", "logs/sub/app.log")).toBe(false);
    expect(globMatch("file?.txt", "file1.txt")).toBe(true);
    expect(globMatch("file?.txt", "file10.txt")).toBe(false);
  });

  it("不含 / 的模式按段名匹配任意层", () => {
    expect(globMatch("*.key", "api.key")).toBe(true);
    expect(globMatch("*.key", "secrets/api.key")).toBe(true);
    expect(globMatch("*.key", "secrets/api.key.bak")).toBe(false);
    expect(globMatch("node_modules", "a/node_modules/b.js")).toBe(true);
    expect(globMatch(".env*", "config/.env.production")).toBe(true);
  });

  it("分隔符等价与大小写不敏感（Windows）", () => {
    expect(globMatch("src/**/x.ts", "src\\a\\x.ts")).toBe(true);
    expect(globMatch("*.KEY", "secrets.Api.key")).toBe(true);
    expect(globMatch("Build/**", "BUILD/a/b")).toBe(true);
  });
});
