import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildUpdateNotes } from "./update-release-notes.mjs";
import { createUpdateNotesModel } from "../src/lib/updateNotes";
import { ReleaseNotes } from "../src/components/update/UpdateNotesDialog";

describe("published updater notes contract", () => {
  it("真实 CHANGELOG 经发布封装后，旧客户端也能汇总跳过的版本", () => {
    const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf-8");
    const latest = changelog.match(/## \[2\.9\.1\][^\n]*\n([\s\S]*?)(?=\n## )/)![1].trim();
    const body = buildUpdateNotes(latest, "2.9.1", changelog);
    // No bundled history: simulate an older binary that knows none of these newer releases.
    const model = createUpdateNotesModel({ version: "2.9.1", currentVersion: "2.7.7", body }, []);
    expect(model.releases.map(release => release.version)).toEqual(["2.9.1", "2.9.0", "2.8.1", "2.8.0"]);
    expect(model.total).toBe(72);
    expect(model.counts).toEqual({ 新增: 35, 修复: 22, 改进: 15 });
    expect(model.highlights).toHaveLength(4);
    expect(model.latest.summary.join(" ")).toContain("右键复制修好了");
  });

  it("兼容旧说明渲染器，不显示元数据或额外版本内容", () => {
    const body = buildUpdateNotes("### 修复\n- only visible", "2.10.0", "## [2.10.0] - 2026-10-18\n### 新增\n- hidden history\n## [2.9.0] - 2026-10-16\n### 修复\n- older hidden");
    const html = renderToStaticMarkup(ReleaseNotes({ body }));
    expect(html).toContain("only visible");
    expect(html).not.toContain("hidden history");
    expect(html).not.toContain("older hidden");
    expect(html).not.toContain("cc-bridge-release-history");
  });
});
