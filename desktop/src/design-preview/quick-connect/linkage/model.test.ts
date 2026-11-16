import { describe, expect, it } from "vitest";
import { connectionSummary, evidenceKey, type AccessEvidence, type LinkageInput } from "./model";
import { status } from "../mock";
const applied: AccessEvidence = { method: "stable", connectionId: "cloud", address: "http://127.0.0.1:7823/mcp", scope: "project", projectPath: "/home/ubuntu/apps/orders", token: status.token };
const input: LinkageInput = { method: "stable", connectionId: "cloud", serverName: "我的云服务器", record: { connectionId: "cloud", port: 7823, scope: "project", projectPath: applied.projectPath, configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, multiDevice: false }, status, ip: "192.168.31.81", directScope: "project", directPath: applied.projectPath, applied, verifiedKey: evidenceKey(applied), copiedCommand: false };
describe("联动设计稿的接入证据和操作", () => {
  it("VPN 重连保留固定地址，不生成 IP 替换命令", () => {
    const summary = connectionSummary({ ...input, record: { ...input.record!, phase: "reconnecting" } });
    expect(summary.state).toBe("recovery"); expect(summary.address).toBe(applied.address); expect(summary.ipCommand).toBe(""); expect(summary.verified).toBe(false);
  });
  it("未配置的隧道不生成地址或回退直连命令", () => {
    const summary = connectionSummary({ ...input, record: undefined, applied: null });
    expect(summary.state).toBe("setup"); expect(summary.address).toBe(""); expect(summary.command).toBe(""); expect(summary.canCopyCommand).toBe(false);
  });
  it("历史请求不能核实当前接入", () => {
    expect(connectionSummary({ ...input, verifiedKey: null }).verified).toBe(false);
  });
  it("切换服务器后旧证据失效", () => {
    expect(connectionSummary({ ...input, connectionId: "dev", record: undefined }).verified).toBe(false);
  });
  it("切换方式不会声称远端已经切换", () => {
    const summary = connectionSummary({ ...input, method: "direct" });
    expect(summary.selectionPending).toBe(true); expect(summary.verified).toBe(false);
  });
  it("Token 变化使当前接入待更新", () => {
    const summary = connectionSummary({ ...input, status: { ...status, token: "NEW_PREVIEW_TOKEN" } });
    expect(summary.state).toBe("changed"); expect(summary.verified).toBe(false); expect(summary.canCopyCommand).toBe(false);
  });
  it("直连地址更新命令读取原接入位置", () => {
    const direct = { ...applied, method: "direct" as const, connectionId: "direct", address: "http://192.168.31.81:7823/mcp" };
    const summary = connectionSummary({ ...input, method: "direct", applied: direct, ip: "10.203.5.58", directScope: "user", directPath: "", status: { ...status, ipChanged: true } });
    expect(summary.ipCommand).toContain(direct.projectPath); expect(summary.ipCommand).toContain(".mcp.json"); expect(summary.previousAddress).toBe(direct.address);
  });
  it("暂停状态不因历史证据变成已连接", () => {
    expect(connectionSummary({ ...input, record: { ...input.record!, phase: "stopped" } }).state).toBe("paused");
  });
  it("停止本机服务优先于隧道状态", () => {
    const summary = connectionSummary({ ...input, status: { ...status, running: false } });
    expect(summary.state).toBe("service-stopped"); expect(summary.verified).toBe(false);
  });
  it("新范围与项目不能继承旧接入成功", () => {
    const summary = connectionSummary({ ...input, record: { ...input.record!, scope: "user", projectPath: "" } });
    expect(summary.state).toBe("changed"); expect(summary.verified).toBe(false);
  });
});
