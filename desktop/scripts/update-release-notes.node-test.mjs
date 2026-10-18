import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpdateNotes } from "./update-release-notes.mjs";

const decode = (notes) => JSON.parse(notes.match(/<!-- cc-bridge-release-history:(.*?) -->/)[1]);
test("preserves legacy notes and carries sorted history without unreleased or private sections", () => {
  const markdown = "## [Unreleased]\n### 新增\n- future\n## [2.9.0] - 2026-10-16\n### 亮点\n- **分屏**：并排\n### 用户摘要\n- private\n### 新增\n- shipped\n## [2.10.0] - 2026-10-18\n### 新增\n- latest\n";
  const result = buildUpdateNotes("### 新增\n- visible", "2.10.0", markdown);
  assert.ok(result.startsWith("### 新增\n- visible\n\n"));
  const entries = decode(result);
  assert.deepEqual(entries.map(entry => entry.version), ["2.10.0", "2.9.0"]);
  assert.ok(entries[1].body.includes("**分屏**"));
  assert.ok(!entries[1].body.includes("private"));
  assert.ok(!result.includes("future"));
  assert.equal(result.split("\n").filter(line => line.startsWith("###")).length, 1);
});
test("limits history and escapes comment terminators without losing content", () => {
  const source = Array.from({ length: 12 }, (_, index) => `## [1.0.${index}] - 2026-10-18\n### 修复\n- <test --> value>\n`).join("\n");
  const entries = decode(buildUpdateNotes("notes", "1.0.11", source));
  assert.equal(entries.length, 10);
  assert.equal(entries[0].version, "1.0.11");
  assert.ok(entries[0].body.includes("<test --> value>"));
});
test("unknown target or missing changelog preserves legacy output", () => {
  assert.equal(buildUpdateNotes("notes", "99.0.0", ""), "notes");
  assert.equal(buildUpdateNotes("notes", "99.0.0", "## [1.0.0] - 2026-10-18\n- old"), "notes");
});
