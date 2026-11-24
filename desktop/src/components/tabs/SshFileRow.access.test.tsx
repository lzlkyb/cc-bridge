// @vitest-environment jsdom
/**
 * 「你不可读」预标的渲染验收（设计稿 design/SSH文件面板-不可读预标与诊断复制-设计稿-2026-11-24.html）。
 *
 * 直接喂 `viewer` 给 FileTable：判定逻辑（canReadEntry）在 utils.test.ts 里已
 * 单测覆盖，这里只钉「判定结果怎么落到行上」——锁图标、徽标、title、软链不预标。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FileTable } from "./SshFileRow";
import type { SshFileEntry, RemoteViewer } from "../../lib/types";

const noop = () => {};
// 事故机身份：lizuliang uid 1004，主组 1006，附加组 1002/1003
const viewer: RemoteViewer = { uid: 1004, gid: 1006, groups: [1006, 1002, 1003] };

const base = { isDir: false, isSymlink: false, size: 1, mtime: 0 };
const entries: SshFileEntry[] = [
  // 事故原样：属 claude-svc(1001)、mode 0600 ⇒ 明确不可读
  { ...base, name: "own-model.json", uid: 1001, gid: 1002, mode: 0o600 },
  // 归自己 ⇒ 可读
  { ...base, name: "mine.conf", uid: 1004, gid: 1006, mode: 0o600 },
  // 软链：条目级语义，不预标（目标可读性交给读失败诊断）
  { ...base, name: "deploy.sh", isSymlink: true, linkTarget: "/opt/x", uid: 1001, gid: 1001, mode: 0o777 },
  // 缺归属（旧服务器）⇒ 不预标
  { ...base, name: "legacy.txt", size: 3 },
];

let root: Root;
let host: HTMLDivElement;

function render(viewerProp: RemoteViewer | null) {
  return act(async () => {
    root.render(
      <FileTable
        entries={entries}
        loading={false}
        error={null}
        busy={false}
        onOpenDir={noop}
        onDownload={noop}
        onRemove={noop}
        onRename={noop}
        onMove={noop}
        sort={{ key: "name", dir: "asc" }}
        onToggleSort={noop}
        viewer={viewerProp}
      />,
    );
  });
}

const rowOf = (name: string) =>
  [...host.querySelectorAll<HTMLTableRowElement>("tbody tr")].find((tr) =>
    tr.textContent?.includes(name),
  )!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("明确不可读的文件：锁图标 + 「你不可读」徽标 + 完整 title", async () => {
  await render(viewer);
  const row = rowOf("own-model.json");
  // 徽标
  expect(row.textContent).toContain("你不可读");
  // 锁图标（可访问名）+ 文件图标不再出现
  expect(row.querySelector('[aria-label="你不可读"]')).not.toBeNull();
  // title 带出属主/权限/出路（数字即可：预标手里只有 attrs）
  expect(row.getAttribute("title")).toContain("属主 uid 1001");
  expect(row.getAttribute("title")).toContain("0600");
  expect(row.getAttribute("title")).toContain("放权");
});

it("归自己 / 缺归属 / 软链：不预标，title 仍是「双击编辑」", async () => {
  await render(viewer);
  for (const name of ["mine.conf", "legacy.txt", "deploy.sh"]) {
    const row = rowOf(name);
    expect(row.textContent, `${name} 不该有徽标`).not.toContain("你不可读");
    expect(row.getAttribute("title"), `${name} 的 title`).toBe("双击编辑");
  }
});

it("身份拉不到（null）：整表不预标——增强项失败不能影响列目录", async () => {
  await render(null);
  expect(host.textContent).not.toContain("你不可读");
  expect(rowOf("own-model.json").getAttribute("title")).toBe("双击编辑");
});
