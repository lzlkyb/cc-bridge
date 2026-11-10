import { describe, expect, it } from "vitest";
import { ACTIVATE_GRACE_MS, shouldStartDrag } from "./titlebarDrag";

// 前端 tsconfig 故意不装 @types/node（src 跑在 WebView 里，不该有 process/Buffer）。
// 读源码文本走 Vite 的 raw 导入，不碰 fs。
const RAW_TSX = import.meta.glob("../**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(rel: string): string {
  const key = Object.keys(RAW_TSX).find((k) => k.endsWith(rel));
  if (!key) throw new Error(`找不到源文件：${rel}`);
  return RAW_TSX[key];
}

describe("shouldStartDrag —— 这一下 mousedown 该不该拖窗口", () => {
  it("窗口在后台时只激活，不拖", () => {
    expect(shouldStartDrag(10_000, 0, false)).toBe(false);
  });

  it("焦点是几毫秒前才拿到的，视为这次点击触发的激活，不拖", () => {
    expect(shouldStartDrag(10_050, 10_000, true)).toBe(false);
  });

  it("焦点拿到很久之后再按，正常拖动", () => {
    expect(shouldStartDrag(20_000, 10_000, true)).toBe(true);
  });

  it("还没记录过焦点时间（刚挂载、窗口本来就在前台）按已聚焦处理", () => {
    expect(shouldStartDrag(10_000, 0, true)).toBe(true);
  });

  it("时间窗边界：正好到 400ms 就开始拖，差 1ms 不拖", () => {
    expect(shouldStartDrag(10_000 + ACTIVATE_GRACE_MS - 1, 10_000, true)).toBe(false);
    expect(shouldStartDrag(10_000 + ACTIVATE_GRACE_MS, 10_000, true)).toBe(true);
  });
});

describe("所有拖拽区都改由自己接管", () => {
  it("三处拖拽区都写了 data-tauri-drag-region=\"false\" 并挂了自己的 handler", () => {
    const header = source("components/layout/Header.tsx");
    const sideNav = source("components/layout/SideNav.tsx");
    const strip = source("components/tabs/TerminalFullscreenDragStrip.tsx");
    for (const [name, text] of [
      ["Header.tsx", header],
      ["SideNav.tsx", sideNav],
      ["TerminalFullscreenDragStrip.tsx", strip],
    ] as const) {
      expect(text, `${name} 未关闭内置拖拽`).toContain('data-tauri-drag-region="false"');
    }
    expect(header).toContain("onMouseDown={onTitlebarMouseDown}");
    expect(sideNav).toContain("onMouseDown={onTitlebarMouseDown}");
    expect(strip).toContain("useTitlebarDrag()");
  });

  it("没有遗留裸的 data-tauri-drag-region（那会重新落回内置脚本）", () => {
    // 裸属性（不带 =）会命中 tauri 内置 drag.js：mousedown 就无条件 start_dragging，
    // 不判断窗口是否已聚焦 —— 正是 H8 的成因。
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(RAW_TSX)) {
      if (/\.test\.tsx$/.test(path)) continue;
      text.split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // 跳过注释行
        if (/data-tauri-drag-region(?!\s*=)/.test(line)) {
          offenders.push(`${path.replace("../", "src/")}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
