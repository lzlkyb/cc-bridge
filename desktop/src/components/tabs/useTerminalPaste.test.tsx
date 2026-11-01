// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

const clip = vi.hoisted(() => ({ text: "" as string, throw: false }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: async () => {
    if (clip.throw) throw new Error("clipboard locked");
    return clip.text;
  },
}));
const invokeMock = vi.hoisted(() =>
  vi.fn(async (_cmd: string, _args: { sessionId: string; data: string }) => undefined),
);
vi.mock("../../lib/tauri", () => ({ invoke: invokeMock }));
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({ toast: toastMock }));

import { useTerminalPaste, PASTE_CONFIRM_WINDOW_MS } from "./useTerminalPaste";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement;
let api: { paste: () => Promise<boolean> };
const focusSpy = vi.fn();
const termRef: { current: Terminal | null } = { current: null };

function Harness() {
  api = useTerminalPaste({
    sessionId: "s1",
    closedRef: { current: false },
    termRef,
  });
  return null;
}

const sentData = () => invokeMock.mock.calls.map((c) => c[1].data);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clip.throw = false;
  termRef.current = {
    focus: focusSpy,
    modes: { bracketedPasteMode: false },
  } as unknown as Terminal;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("useTerminalPaste 两段式确认", () => {
  it("🔴 拦下多行粘贴时把焦点还给终端（否则从工具栏触发后确认键到不了 xterm）", async () => {
    clip.text = "a\nb";
    await act(async () => {
      await api.paste();
    });
    expect(sentData()).toEqual([]); // 只提示，不执行
    expect(toastMock).toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalled(); // ← 改前这里从不调用，10 秒窗口就是死路
  });

  it("窗口内内容未变 → 第二次按键即确认发送", async () => {
    clip.text = "a\nb";
    await act(async () => {
      await api.paste();
    });
    await act(async () => {
      await api.paste();
    });
    expect(sentData()).toHaveLength(1);
    expect(sentData()[0]).toContain("a");
  });

  it("🔴 期间剪贴板换了内容 → 不拿旧内容执行，按新内容重新判定", async () => {
    clip.text = "rm -rf /tmp/x\necho done";
    await act(async () => {
      await api.paste();
    });
    expect(sentData()).toEqual([]);
    clip.text = "ls\necho hi"; // 用户又复制了别的
    await act(async () => {
      await api.paste();
    });
    // 既不能发旧的危险内容，也不能把新内容当「已确认」直接执行
    expect(sentData()).toEqual([]);
    expect(toastMock).toHaveBeenCalledTimes(2);
  });

  it("超出确认窗口 → 重新提示，不执行", async () => {
    clip.text = "a\nb";
    await act(async () => {
      await api.paste();
    });
    await act(async () => {
      vi.advanceTimersByTime(PASTE_CONFIRM_WINDOW_MS + 1);
    });
    await act(async () => {
      await api.paste();
    });
    expect(sentData()).toEqual([]);
  });

  it("单行内容直接发，不打扰", async () => {
    clip.text = "git status";
    await act(async () => {
      await api.paste();
    });
    expect(sentData()).toHaveLength(1);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("远端开了 bracketed paste → 多行也不确认（整块插入不执行）", async () => {
    (termRef.current as unknown as { modes: { bracketedPasteMode: boolean } }).modes.bracketedPasteMode = true;
    clip.text = "a\nb";
    await act(async () => {
      await api.paste();
    });
    expect(sentData()).toHaveLength(1);
  });
});

describe("paste 的返回值（Ctrl+Shift+V 据此决定退化成图片上传）", () => {
  it("剪贴板有文本 → true", async () => {
    clip.text = "hello";
    let r = false;
    await act(async () => {
      r = await api.paste();
    });
    expect(r).toBe(true);
  });

  it("剪贴板没有文本 → false（调用方于是去试图片）", async () => {
    clip.text = "";
    let r = true;
    await act(async () => {
      r = await api.paste();
    });
    expect(r).toBe(false);
    expect(sentData()).toEqual([]);
    // 空剪贴板静默：不弹提示
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("读取剪贴板失败 → false 且必须报错", async () => {
    clip.throw = true;
    let r = true;
    await act(async () => {
      r = await api.paste();
    });
    expect(r).toBe(false);
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining("读取剪贴板失败"), "error");
  });
});
