import { describe, expect, it } from "vitest";
import { compareReleaseVersions, countReleaseItems, createUpdateNotesModel, parseUpdateNotes } from "./updateNotes";
import type { ChangelogEntry } from "./about";

const entry = (version: string, text = version): ChangelogEntry => ({
  version, date: "2026-10-16", highlights: [text], items: [{ category: "feat", text }],
});
const history = [entry("2.10.0"), entry("2.9.1"), entry("2.9.0"), entry("2.8.1"), entry("2.8.0"), entry("2.7.7")];

describe("update release notes", () => {
  it("比较数字版本，未知和预发布版本不猜测范围", () => {
    expect(compareReleaseVersions("v2.10.0", "2.9.1")).toBeGreaterThan(0);
    expect(compareReleaseVersions("2.9.1", "2.9.1")).toBe(0);
    expect(compareReleaseVersions("2.10.0-beta.1", "2.9.1")).toBeNull();
    expect(compareReleaseVersions("unknown", "2.9.1")).toBeNull();
  });

  it("摘要与亮点不重复计数，续行和未知分类均保留", () => {
    const notes = parseUpdateNotes("### 更新摘要\n总体改善\n### 亮点\n- **分屏**：两个会话\n### 新增\n- A\n  continued\n### 优化\n- B\n### 变更\n- C\n### 兼容性\n- D\n### 用户摘要\n- hidden");
    expect(notes.summary).toEqual(["总体改善"]);
    expect(notes.highlights).toEqual(["**分屏**：两个会话"]);
    expect(notes.groups).toEqual([{ label: "新增", items: ["A continued"] }, { label: "改进", items: ["B", "C"] }, { label: "兼容性", items: ["D"] }]);
    expect(countReleaseItems(notes)).toBe(4);
  });

  it("只聚合当前版本之后、目标版本以内，保留每个来源版本", () => {
    const model = createUpdateNotesModel({ version: "2.9.1", currentVersion: "2.7.7" }, history);
    expect(model.releases.map(release => release.version)).toEqual(["2.9.1", "2.9.0", "2.8.1", "2.8.0"]);
    expect(model.total).toBe(4);
    expect(model.highlights.map(highlight => highlight.version)).toEqual(["2.9.1", "2.9.0", "2.8.1", "2.8.0"]);
    expect(model.counts).toEqual({ 新增: 4 });
  });

  it.each([undefined, "unknown", "2.10.0", "2.9.1"])("当前版本不可确定或未升级时，只显示目标版本 (%s)", currentVersion => {
    const model = createUpdateNotesModel({ version: "2.9.1", currentVersion }, history);
    expect(model.releases).toHaveLength(1);
    expect(model.total).toBe(1);
  });

  it("较新的远端记录补齐旧客户端未知的版本，不使用已安装历史冒充升级收益", () => {
    const remote = [{ version: "2.11.0", date: "2026-10-18", body: "### 亮点\n- 最新：新功能\n### 新增\n- latest" }, { version: "2.10.0", body: "### 亮点\n- 中间：新功能\n### 修复\n- skipped" }];
    const model = createUpdateNotesModel({ version: "2.11.0", currentVersion: "2.9.1", body: "### 新增\n- latest\n\n<!-- cc-bridge-release-history:" + JSON.stringify(remote) + " -->" }, history);
    expect(model.releases.map(release => release.version)).toEqual(["2.11.0", "2.10.0"]);
    expect(model.total).toBe(2);
    expect(model.highlights).toContainEqual({ version: "2.11.0", text: "最新：新功能" });
    expect(model.highlights).toContainEqual({ version: "2.10.0", text: "中间：新功能" });
  });

  it("旧格式、纯文字、空数据及损坏元数据都有可读降级", () => {
    const plain = createUpdateNotesModel({ version: "99.0.0", body: "This is a plain note." }, []);
    expect(plain.latest.paragraphs).toEqual(["This is a plain note."]);
    expect(plain.total).toBe(0);
    const broken = createUpdateNotesModel({ version: "99.0.0", body: "### 修复\n- preserved\n<!-- cc-bridge-release-history:{bad} -->" }, []);
    expect(broken.latest.groups[0].items).toEqual(["preserved"]);
    expect(broken.latest.paragraphs).toEqual([]);
    expect(createUpdateNotesModel({ version: "99.0.0", body: "" }, []).total).toBe(0);
  });

  it("亮点去重并限制四项，优先覆盖不同版本", () => {
    const source = [entry("2.9.1", "same"), entry("2.9.0", "same"), entry("2.8.1", "older")];
    source[0].highlights!.push("extra1", "extra2", "extra3", "extra4");
    const model = createUpdateNotesModel({ version: "2.9.1", currentVersion: "2.7.7" }, source);
    expect(model.highlights.map(highlight => highlight.text)).toEqual(["same", "older", "extra1", "extra2"]);
  });
});
