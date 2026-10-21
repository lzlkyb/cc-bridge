// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectGuide } from "./ConnectGuide";
import { useConnectGuideState } from "../../../hooks/useConnectGuideState";
import { ToastProvider } from "../../ui/toast";
import type { StaticStatus } from "../../../lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn(), copy: vi.fn(), requests: 0 }));
vi.mock("../../../lib/tauri", () => ({ invoke: mocks.invoke, invokeOrToast: mocks.save }));
vi.mock("../../../hooks/useCopyFeedback", () => ({ useCopyFeedback: () => ({
  copy: (key: string, command: string, options?: { onCopied?: () => void }) => { mocks.copy(key, command); options?.onCopied?.(); },
  isCopied: () => false,
}) }));
vi.mock("../../../hooks/useAutoAnimateRM", () => ({ useAutoAnimateRM: () => ({ current: null }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: ({ queryKey, select }: { queryKey: string[]; select?: (s: unknown) => unknown }) => ({
  data: queryKey[0] === "tls-status" ? { enabled: false } : select?.({ stats: { totalRequests: mocks.requests } }),
}) }));
const base = { running: true, host: "0.0.0.0", port: 7823, token: "token-old", scope: "project", projectPath: "", transport: "http", connectClient: "claude-code", multiDeviceMode: false, hasOnboarded: true } as StaticStatus;
let host: HTMLDivElement;
let root: Root;
function Harness({ status = base }: { status?: StaticStatus }) {
  const guide = useConnectGuideState(status, "10.0.7.185");
  return <ToastProvider><ConnectGuide status={status} guide={guide} listenAll={false} lanIps={[]} selectedIp="10.0.7.185" onSelectIp={() => {}} onRefresh={() => {}} /></ToastProvider>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockReset().mockResolvedValue("token-new"); mocks.save.mockReset().mockResolvedValue(true); mocks.copy.mockReset(); mocks.requests = 0;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(e => e.textContent === text)!;
const click = (text: string) => act(async () => button(text).click());
const mount = (status = base) => act(async () => root.render(<Harness status={status} />));

it.each([true, false])("已接入状态为 %s 时四块主要操作均常驻", async hasOnboarded => {
  await mount({ ...base, hasOnboarded });
  expect([...host.querySelectorAll("h3")].map(e => e.textContent)).toEqual(["接入模式", "接入命令", "访问令牌", "权限自动授权"]);
  for (const name of ["复制连接命令", "复制授权命令", "显示", "重生成"]) expect(button(name)).toBeDefined();
  expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  expect(host.querySelector(".connect-token")!.textContent).not.toContain("token-old");
});
it("路径正确转义，展示与复制同一命令，切换全局不携带项目 cd", async () => {
  await mount({ ...base, projectPath: '/home/My Project/$data"`x' });
  const code = host.querySelector(".connect-main-code")!.textContent!;
  expect(code).toContain('cd "/home/My Project/\\$data\\"\\`x" &&');
  await click("复制连接命令");
  expect(mocks.copy).toHaveBeenLastCalledWith("connect", code);
  const global = [...host.querySelectorAll<HTMLButtonElement>(".selection-card")].find(e => e.textContent?.startsWith("全局模式"))!;
  await act(async () => global.click());
  expect(host.querySelector(".connect-path")).toBeNull();
  expect(host.querySelector(".connect-main-code")!.textContent).toContain("--scope user");
  expect(host.querySelector(".connect-main-code")!.textContent).not.toContain("cd ");
  expect(button("显示")).toBeDefined();
});
it("空命令不能复制，也不会拼出可误执行的 cd 占位命令", async () => {
  const { ConnectCommand } = await import("./ConnectCommand");
  await act(async () => root.render(<ConnectCommand scope="project" command="" projectPath="/tmp/test" setProjectPath={() => {}} copied={false} onCopy={mocks.copy} firstCallSeen={false} />));
  expect(button("复制连接命令").disabled).toBe(true);
  expect(host.querySelector("code")!.textContent).toBe("正在生成连接命令…");
});
it("保存的家目录简写在连接命令中仍可展开，复制内容与展示一致", async () => {
  await mount({ ...base, projectPath: "~/My Project" });
  const command = host.querySelector(".connect-main-code")!.textContent!;
  expect(command).toContain('cd "$HOME/My Project" &&');
  await click("复制连接命令"); expect(mocks.copy).toHaveBeenLastCalledWith("connect", command);
});
it("查看脚本不隐藏其他操作，默认不扩大免确认范围，复制包含完整脚本", async () => {
  await mount();
  await click("复制授权命令");
  const script = mocks.copy.mock.calls[mocks.copy.mock.calls.length - 1][1] as string;
  expect(script).toContain("json.dump"); expect(script).not.toContain("mcp__cc-bridge__*");
  await click("查看完整脚本");
  expect(host.querySelector(".connect-permission-script code")!.textContent).toBe(script);
  expect(button("复制连接命令")).toBeDefined(); expect(button("显示")).toBeDefined();
  await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(host.textContent).toContain("仅在完全信任此连接时使用");
  await click("复制授权命令");
  expect(mocks.copy.mock.calls[mocks.copy.mock.calls.length - 1][1]).toContain("mcp__cc-bridge__*");
});
it("令牌重生成必须确认，刷新前显示和修复命令使用返回的新值", async () => {
  await mount();
  await click("重生成"); expect(mocks.invoke).not.toHaveBeenCalled();
  await click("取消"); expect(mocks.invoke).not.toHaveBeenCalled();
  await click("重生成"); await click("确定");
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("regenerate_token");
  expect(host.textContent).toContain("Token 已更新");
  await click("显示");
  expect(host.querySelector(".connect-token-actions code")!.textContent).toBe("token-new");
  expect(host.textContent).toContain("Bearer token-new");
  await mount({ ...base, token: "token-external" });
  expect(host.querySelector(".connect-token-actions code")!.textContent).toBe("token-external");
});
it("多设备采用实际全局范围，不显示项目路径，授权与复制范围一致", async () => {
  await mount({ ...base, multiDeviceMode: true, projectPath: "/project", deviceId: "device1" });
  expect(host.textContent).toContain("多设备接入固定使用全局模式");
  expect(host.querySelector(".connect-path")).toBeNull();
  expect(host.querySelector(".connect-main-code")!.textContent).toContain("-s user");
  await click("复制授权命令"); expect(mocks.copy.mock.calls[mocks.copy.mock.calls.length - 1][1]).toContain("~/.claude/settings.json");
  await click("复制连接命令");
  expect(mocks.save).toHaveBeenCalledWith("save_config", { patch: { scope: "user", projectPath: "/project", hasOnboarded: true } });
});
it("复制不宣称接入成功，首次真实调用到达后才显示成功提示", async () => {
  await mount(); await click("复制连接命令");
  expect(host.textContent).not.toContain("已收到首次调用");
  mocks.requests = 1; await mount();
  expect(host.textContent).toContain("已收到首次调用，配置生效");
});
it("多设备的延迟自动保存不会把全局范围写回项目级", async () => {
  vi.useFakeTimers();
  await mount({ ...base, multiDeviceMode: true, projectPath: "/project", deviceId: "device1" });
  await click("复制连接命令");
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(mocks.save.mock.calls).toEqual([
    ["save_config", { patch: { scope: "user", projectPath: "/project", hasOnboarded: true } }],
    ["save_config", { patch: { scope: "user", projectPath: "/project" } }],
  ]);
  for (const call of mocks.save.mock.calls) expect(call[1].patch.scope).toBe("user");
});
it("重生成失败时保留原令牌且允许重试", async () => {
  mocks.invoke.mockRejectedValue(new Error("test failure"));
  await mount(); await click("重生成"); await click("确定");
  expect(host.textContent).toContain("Token 重生成失败");
  expect(button("确定").disabled).toBe(false);
  await click("取消"); await click("显示");
  expect(host.querySelector(".connect-token-actions code")!.textContent).toBe("token-old");
});
