import { describe, it, expect } from "vitest";
import { summarizeParams, perfSummaryLine, prettyParams } from "./logFormat";
import type { AuditEntry } from "./types";

const mk = (o: Partial<AuditEntry>): AuditEntry => ({
  timestamp: "2026-09-16T00:00:00Z",
  tool: "read_file",
  params: "{}",
  success: true,
  ...o,
});

/**
 * 这三条函数原本散在两个组件里、零测试覆盖。断言锁两类容易静默坏掉的东西：
 * ① JSON parse 失败必须**退回原文**而不是抛异常或吐空串（日志页会因为一条
 *    坏记录整块白屏）；
 * ② P95 / 占比 / 错误率的口径——把缺 `durationMs` 的旧条目当 0 参与统计，
 *    会让 P95 偏低、错误率算歪，用户按这个数去查瓶颈会查错方向。
 */
describe("summarizeParams", () => {
  it("文件批量操作：报项数，带 encoding 一并显示", () => {
    expect(summarizeParams('{"files":[{"a":1},{"a":2}],"encoding":"utf-8"}')).toBe(
      "files: 2 项 · encoding: utf-8",
    );
  });

  it("单文件操作：路径只留末段（表格列宽有限）", () => {
    expect(summarizeParams('{"path":"/home/user/docs/a.txt"}')).toBe("path: …/a.txt");
  });

  it("Windows 反斜杠路径同样能取末段", () => {
    expect(summarizeParams('{"path":"C:\\\\Users\\\\x\\\\b.txt"}')).toBe("path: …/b.txt");
  });

  it("oldString 片段带引号显示，便于看出改的是哪段", () => {
    expect(summarizeParams('{"oldString":"hello world"}')).toBe('oldString: "hello world"');
  });

  it("path 与 oldString 同时存在时用 · 连接", () => {
    expect(summarizeParams('{"path":"/a/b.txt","oldString":"x"}')).toBe(
      "path: …/b.txt · oldString: \"x\"",
    );
  });

  it("非 JSON：退回原文", () => {
    expect(summarizeParams("not json")).toBe("not json");
  });

  it("JSON 合法但无可识别字段：退回原文", () => {
    expect(summarizeParams('{"foo":1}')).toBe('{"foo":1}');
  });

  it("JSON 标量与 null 也算“无结构”，退回原文", () => {
    expect(summarizeParams("123")).toBe("123");
    expect(summarizeParams("null")).toBe("null");
  });

  it("超长原文截断到 60 字符并补省略号", () => {
    const raw = "x".repeat(100);
    const r = summarizeParams(raw);
    expect(r).toHaveLength(61);
    expect(r.endsWith("…")).toBe(true);
  });
});

describe("perfSummaryLine", () => {
  it("空数组：明确说没有数据，不是空白", () => {
    expect(perfSummaryLine([])).toBe("暂无耗时数据");
  });

  it("条目全都缺 durationMs（旧后端写入的）→ 同样报无数据", () => {
    expect(perfSummaryLine([mk({}), mk({})])).toBe("暂无耗时数据");
  });

  it("P95 / 占比 / 错误率", () => {
    // 20 条，100..2000 步长 100；全部成功且同工具 → 占比 100%
    const entries = Array.from({ length: 20 }, (_, i) =>
      mk({ durationMs: (i + 1) * 100, tool: "read_file" }),
    );
    const r = perfSummaryLine(entries);
    expect(r).toContain("P95 1900ms");
    expect(r).toContain("占 100.0%");
    expect(r).toContain("错误率 0.0%");
  });

  it("错误率按全部条目算，不只是有耗时的那些", () => {
    const entries = [
      mk({ durationMs: 100, success: true }),
      mk({ durationMs: 100, success: true }),
      mk({ durationMs: 100, success: false }),
      mk({ durationMs: 100, success: false }),
    ];
    expect(perfSummaryLine(entries)).toContain("错误率 50.0%");
  });

  it("缺耗时的那条不拉低 P95（被排除在样本外）", () => {
    const entries = [mk({ durationMs: 500 }), mk({ durationMs: 500 }), mk({})];
    const r = perfSummaryLine(entries);
    expect(r).toContain("P95 500ms");
  });

  it("单条也能算（边界：样本数为 1 不越界）", () => {
    expect(perfSummaryLine([mk({ durationMs: 42 })])).toContain("P95 42ms");
  });
});

describe("prettyParams", () => {
  it("合法 JSON 缩进两格", () => {
    expect(prettyParams('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("非法 JSON 原样返回（不抛、不吞）", () => {
    expect(prettyParams("{oops")).toBe("{oops");
  });
});
