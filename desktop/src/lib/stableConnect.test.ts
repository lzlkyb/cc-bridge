import { describe, expect, it } from "vitest";
import { stableConnectCommand, stableSetupMatches, stableProgressIndex, usesStableConnection, type StableConnection, type StableConnectSnapshot, type StableSetup } from "./stableConnect";
import { stableConfirmedPort } from "./stableAccess";
import type { StaticStatus } from "./types";

const setup: StableSetup = { scope: "project", projectPath: "/srv/app", multiDevice: false };
const connection: StableConnection = {
  connectionId: "server-a", port: 43127, ...setup, configured: true, enabled: true,
  phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true,
};
const status = { running: true, host: "10.7.0.9", port: 7823, token: "real-token", transport: "http", deviceId: "device-42", connectClient: "claude-code" } as StaticStatus;
const snapshot: StableConnectSnapshot = { method: "stable", selectedConnectionId: "server-a", connections: [connection] };

describe("接入进度分组", () => {
  it.each([[0, 0], [1, 0], [2, 0], [3, 1], [4, 2]])("后台步骤 %i 对应用户步骤 %i", (step, visible) => {
    expect(stableProgressIndex(step)).toBe(visible);
  });
});

describe("稳定地址命令", () => {
  it("使用后端确认的远程端口，VPN 地址变化不会改写 MCP 地址", () => {
    const command = stableConnectCommand(connection, status, setup);
    expect(command).toBe('claude mcp add --scope project --transport http cc-bridge http://127.0.0.1:43127/mcp --header "Authorization: Bearer real-token"');
    expect(stableConnectCommand(connection, { ...status, host: "10.8.0.77", port: 9876 }, setup)).toBe(command);
  });

  it("保留实际 SSE 协议与全局范围", () => {
    const command = stableConnectCommand(connection, { ...status, transport: "sse" }, { ...setup, scope: "user" });
    expect(command).toContain("--scope user --transport sse");
    expect(command).toContain("http://127.0.0.1:43127/mcp/sse");
  });

  it("多设备命令只移除当前设备条目并使用其真实标识", () => {
    const command = stableConnectCommand(connection, status, { ...setup, scope: "user", multiDevice: true });
    expect(command.split("\n")).toEqual([
      "claude mcp remove cc-bridge-device-42 2>/dev/null",
      'claude mcp add cc-bridge-device-42 -s user --transport http --header "Authorization: Bearer real-token" http://127.0.0.1:43127/mcp',
    ]);
    expect(stableConnectCommand(connection, { ...status, deviceId: "" }, { ...setup, multiDevice: true })).toBe("");
  });

  it("未取得真实端口或令牌时不生成貌似可用的连接命令", () => {
    expect(stableConnectCommand(undefined, status, setup)).toBe("");
    expect(stableConnectCommand({ ...connection, port: 0 }, status, setup)).toBe("");
    expect(stableConnectCommand(connection, undefined, setup)).toBe("");
    expect(stableConnectCommand(connection, { ...status, token: "" }, setup)).toBe("");
  });

  it("配置尚未完成时不能用占位端口生成地址", () => {
    // step 2 = 隧道刚建起来、远端配置还没写：此时 port 只是候选号，地址还不成立。
    // 早前这里照样出命令，用户抄走的是本机端口（7823）冒充的隧道地址。
    expect(stableConnectCommand({ ...connection, configured: false, step: 2 }, status, setup)).toBe("");
    expect(stableConnectCommand({ ...connection, configured: false, step: 3 }, status, setup))
      .toContain("http://127.0.0.1:43127/mcp");
  });
});

describe("隧道接入端口确认口径", () => {
  it("只有写过远端配置或走到应用配置步，端口才算成立", () => {
    expect(stableConfirmedPort(undefined)).toBeUndefined();
    expect(stableConfirmedPort({ port: 7823 })).toBeUndefined();
    expect(stableConfirmedPort({ port: 7823, configured: false, step: 2 })).toBeUndefined();
    expect(stableConfirmedPort({ port: 17908, configured: false, step: 3 })).toBe(17908);
    expect(stableConfirmedPort({ port: 17908, configured: true, step: 0 })).toBe(17908);
    // 占位值与特权端口都不是合法的隧道监听号
    expect(stableConfirmedPort({ port: 0, configured: true })).toBeUndefined();
    expect(stableConfirmedPort({ port: 80, configured: true })).toBeUndefined();
  });
});

describe("已应用配置与当前草稿匹配", () => {
  it.each<Partial<StableSetup>>([{ scope: "user" }, { projectPath: "/srv/other" }, { multiDevice: true }])("修改 %j 后必须重新应用", patch => {
    expect(stableSetupMatches(connection, { ...setup, ...patch })).toBe(false);
  });
  it("项目路径只忽略首尾空格，不能忽略目录名大小写", () => {
    expect(stableSetupMatches(connection, { ...setup, projectPath: "  /srv/app  " })).toBe(true);
    expect(stableSetupMatches(connection, { ...setup, projectPath: "/srv/App" })).toBe(false);
  });
  it("全局配置不依赖项目路径，但后端判定失效仍必须重新应用", () => {
    expect(stableSetupMatches({ ...connection, scope: "user" }, { ...setup, scope: "user", projectPath: "/elsewhere" })).toBe(true);
    expect(stableSetupMatches({ ...connection, configMatches: false }, setup)).toBe(false);
  });
});

describe("直连 IP 告警抑制范围", () => {
  it("仅选中已配置的 Claude 稳定连接时抑制 IP 告警，重连期间保持固定地址", () => {
    expect(usesStableConnection(snapshot, status)).toBe(true);
    expect(usesStableConnection({ ...snapshot, connections: [{ ...connection, phase: "reconnecting" }] }, status)).toBe(true);
  });
  it("其它服务器已有配置不能替尚未配置的选中服务器隐藏告警", () => {
    expect(usesStableConnection({ ...snapshot, selectedConnectionId: "server-b" }, status)).toBe(false);
    expect(usesStableConnection({ ...snapshot, connections: [{ ...connection, configured: false }] }, status)).toBe(false);
    expect(usesStableConnection({ ...snapshot, selectedConnectionId: null }, status)).toBe(false);
  });
  it.each(["codex", "cursor", "generic"])("%s 仍需处理自己的直连地址", connectClient => {
    expect(usesStableConnection(snapshot, { ...status, connectClient })).toBe(false);
  });
  it("旧用户的直连方式和未读取完成的状态不会被当作稳定连接", () => {
    expect(usesStableConnection({ ...snapshot, method: "direct" }, status)).toBe(false);
    expect(usesStableConnection(undefined, status)).toBe(false);
  });
});
