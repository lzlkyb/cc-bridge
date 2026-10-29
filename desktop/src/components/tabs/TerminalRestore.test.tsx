// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RestoreBanner } from "./TerminalRestore";
import type { SshSessionRef } from "./TerminalConnectionItem";
import type { SshConnection } from "../../lib/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function render(node: ReactNode) {
  act(() => root.render(node));
}
function conn(id: string): SshConnection {
  return {
    id, name: id, host: `${id}.example.com`, port: 22, username: "u", authType: "password",
    rememberPassword: false, encryptedPassword: "", keyPath: "",
    rememberPassphrase: false, encryptedPassphrase: "", proxyJumpId: "",
  };
}
function restored(tabId: string): SshSessionRef {
  return { tabId, sessionId: `restore:${tabId}`, conn: conn(tabId), closedReason: "restored" };
}
function buttonByText(text: string) {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(found).toBeTruthy();
  return found!;
}

it("全部恢复逐条串行：前一条返回前不发下一条", async () => {
  const started: string[] = [];
  let release: (() => void) | null = null;
  const onReconnect = vi.fn(
    (s: SshSessionRef) => new Promise<void>((res) => {
      started.push(s.tabId);
      release = res;
    }),
  );
  render(<RestoreBanner sessions={[restored("a"), restored("b")]} onReconnect={onReconnect} />);

  act(() => buttonByText("全部恢复").click());
  // 🔴 并发发出会撞远端 MaxSessions：此刻只允许第一条在飞。
  expect(started).toEqual(["a"]);
  expect(host.textContent).toContain("恢复中 1/2");

  await act(async () => { release!(); });
  expect(started).toEqual(["a", "b"]);

  await act(async () => { release!(); });
  expect(onReconnect).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("全部恢复");
});

it("底色是不透明 bg-card，且可本次忽略", () => {
  render(<RestoreBanner sessions={[restored("a")]} onReconnect={() => undefined} />);
  const el = host.firstElementChild as HTMLElement;
  // 横幅画在终端画布上（终端的明暗与 app 主题无关）：半透明主题色会叠出 #202027，
  // 把浅色主题的 text-foreground 压到 1.1:1，按钮文字整个消失。
  expect(el.className).toContain("bg-card");
  expect(el.className).not.toContain("bg-primary/5");

  const dismiss = host.querySelector<HTMLButtonElement>('button[aria-label="本次忽略"]');
  expect(dismiss).toBeTruthy();
  act(() => dismiss!.click());
  expect(host.textContent).toBe("");
});

it("没有待恢复会话时什么都不渲染", () => {
  render(
    <RestoreBanner
      sessions={[{ ...restored("a"), closedReason: null }, { ...restored("b"), splitOnly: true }]}
      onReconnect={() => undefined}
    />,
  );
  expect(host.innerHTML).toBe("");
});
