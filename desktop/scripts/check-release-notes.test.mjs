import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MIN_STRICT_VERSION,
  collectItemSections,
  compareVersion,
  parseNotes,
  removeUnreleased,
  validate,
} from "./check-release-notes.mjs";

/** 一段合格的小白向文案，作为「正常情况」的基准。 */
const GOOD = `## [Unreleased]

### 亮点
- **断网时打开软件不再卡住**：以前开机后要先等一项系统检查做完，窗口才出现；断网时这一步可能一直等不到结果，电脑会问你要不要结束程序。现在窗口会先打开，检查放在背后慢慢做。
- **检查更新不再一直转圈**：断网时顶栏的小圆圈以前会转好几分钟，现在最多等一分钟就会告诉你没连上，可以再点一次重试。

### 更新摘要
断网时打开软件、检查更新和连接页面都不再长时间卡住；从别的窗口点一下顶栏，窗口也不会跟着鼠标跑。

### 修复
- 断网时打开软件不再卡住。以前要等一项系统检查做完窗口才出现，断网时这一步可能一直等不到结果，电脑会问你要不要关掉这个软件；现在窗口先打开，检查放在背后慢慢做，最多等十秒就放弃。
- 连接页面上的「防火墙」不再因为一次没检查出来就长时间显示「无法检测」。慢一次不代表这台电脑不支持，现在会自动再试一次。
- 断网时检查更新最多等一分钟。以前顶栏的小圆圈能一直转好几分钟，现在到点就提示没连上，可以马上重试。
- 备份文件夹放在网络硬盘上时，断网不再拖累别的操作。以前翻这个文件夹可能一直等，连别的按钮都点不动。
- 从别的软件窗口点一下顶栏，窗口不再跟着鼠标跑。现在这一下只把软件切到前台，第二下才开始拖；正常拖动和双击最大化都不受影响。
`;

const errorsOf = (md, stage = "unreleased") =>
  validate(parseNotes(md, { stage })).errors;
const codesOf = (md, stage = "unreleased") =>
  errorsOf(md, stage).map((e) => e.code);

/** 把 GOOD 的某一段替换掉，专门验证一条规则。 */
const replace = (from, to) => {
  expect(GOOD).toContain(from);
  return GOOD.replace(from, to);
};

describe("用户向更新日志 · 正常路径", () => {
  it("大白话文案零错误，摘要/亮点/条目都被解析出来", () => {
    const parsed = parseNotes(GOOD);
    expect(parsed.found).toBe(true);
    expect(parsed.summary).toContain("断网时打开软件");
    expect(parsed.highlights).toHaveLength(2);
    expect(Object.keys(collectItemSections(parsed))).toEqual(["修复"]);
    expect(collectItemSections(parsed)["修复"]).toHaveLength(5);
    expect(errorsOf(GOOD)).toEqual([]);
  });

  it("从下一版起，最新发布段也按同样规则校验（历史版本按棘轮豁免）", () => {
    const legacy = GOOD.replace("## [Unreleased]", "## [3.1.5] - 2026-11-10");
    const next = GOOD.replace("## [Unreleased]", `## [${MIN_STRICT_VERSION}] - 2026-11-11`);
    expect(validate(parseNotes(legacy, { stage: "latest" })).skipped).toContain("v3.1.5");
    expect(errorsOf(legacy, "latest")).toEqual([]);
    expect(errorsOf(next, "latest")).toEqual([]);
    expect(compareVersion("3.1.6", "3.1.5")).toBeGreaterThan(0);
    expect(compareVersion("3.1.5", "3.1.6")).toBeLessThan(0);
  });

  it("消费 [Unreleased] 后，后续版本段完整保留、没有残留", () => {
    const rest = removeUnreleased(`${GOOD}\n## [3.1.5] - 2026-11-10\n\n### 修复\n- 旧版本条目\n`);
    expect(rest).not.toContain("[Unreleased]");
    expect(rest).not.toContain("断网时打开软件不再卡住");
    expect(rest).toContain("## [3.1.5] - 2026-11-10");
    expect(rest).toContain("旧版本条目");
  });
});

describe("用户向更新日志 · 每条硬闸都能精确变红", () => {
  it("缺 [Unreleased] 段 → MISSING_SECTION", () => {
    expect(codesOf("# Changelog\n\n## [3.1.5] - 2026-11-10\n")).toContain("MISSING_SECTION");
  });

  it("摘要是「v3.1.6 版本更新」占位 → PLACEHOLDER_SUMMARY", () => {
    const md = replace(
      "断网时打开软件、检查更新和连接页面都不再长时间卡住；从别的窗口点一下顶栏，窗口也不会跟着鼠标跑。",
      "v3.1.6 版本更新",
    );
    expect(codesOf(md)).toContain("PLACEHOLDER_SUMMARY");
  });

  it("完全没有 ### 更新摘要 → MISSING_SUMMARY", () => {
    const md = GOOD.replace(/### 更新摘要\n[\s\S]*?\n\n/, "");
    expect(codesOf(md)).toContain("MISSING_SUMMARY");
  });

  it("摘要写成两行 → MULTILINE_SUMMARY", () => {
    const md = replace(
      "断网时打开软件、检查更新和连接页面都不再长时间卡住；从别的窗口点一下顶栏，窗口也不会跟着鼠标跑。",
      "断网时打开软件不再卡住。\n检查更新也不会一直转圈。",
    );
    expect(codesOf(md)).toContain("MULTILINE_SUMMARY");
  });

  it("git 提交标题混进条目 → COMMIT_TITLE", () => {
    const md = GOOD.replace(
      "- 断网时检查更新最多等一分钟。",
      "- fix: 给更新检查加上总时限",
    );
    expect(codesOf(md)).toContain("COMMIT_TITLE");
  });

  it("同一件事写两遍 → DUPLICATE_ITEM，并报出重复行号", () => {
    const line = "- 断网时检查更新最多等一分钟。以前顶栏的小圆圈能一直转好几分钟，现在到点就提示没连上，可以马上重试。";
    const md = GOOD.replace(line, `${line}\n${line}`);
    expect(codesOf(md)).toContain("DUPLICATE_ITEM");
    expect(errorsOf(md).find((e) => e.code === "DUPLICATE_ITEM").message).toMatch(/第 \d+ 行/);
  });

  it("只有几个字的敷衍条目 → TOO_SHORT", () => {
    const md = GOOD.replace(
      "- 断网时检查更新最多等一分钟。以前顶栏的小圆圈能一直转好几分钟，现在到点就提示没连上，可以马上重试。",
      "- 修复若干问题",
    );
    const codes = codesOf(md);
    expect(codes).toContain("PLACEHOLDER_ITEM");
    expect(codes).toContain("TOO_SHORT");
  });

  it("出现 PowerShell / 主线程 / tokio → TECH_TERM", () => {
    const md = GOOD.replace(
      "以前要等一项系统检查做完窗口才出现",
      "以前主线程上要同步跑一个 PowerShell，tokio 还要轮询",
    );
    const err = errorsOf(md).find((e) => e.code === "TECH_TERM");
    expect(err).toBeDefined();
    expect(err.message).toContain("PowerShell");
    expect(err.hint).toContain("系统检查");
  });

  it("条目换行后，第二行里的黑话也跑不掉", () => {
    const md = GOOD.replace(
      "- 断网时打开软件不再卡住。以前要等一项系统检查做完窗口才出现，断网时这一步可能一直等不到结果，电脑会问你要不要关掉这个软件；现在窗口先打开，检查放在背后慢慢做，最多等十秒就放弃。",
      "- 断网时打开软件不再卡住。以前要等一项系统检查做完窗口才出现，\n  这一步其实是在主线程上跑 PowerShell，断网时可能一直等不到结果。",
    );
    const parsed = parseNotes(md);
    const first = parsed.sections.find((s) => s.name === "修复").items[0];
    expect(first.text).toContain("PowerShell");
    expect(codesOf(md)).toContain("TECH_TERM");
  });

  it("出现反引号 / 函数名 / 文件名 / 源码路径 → CODE_SYMBOL", () => {
    const md = GOOD.replace(
      "以前要等一项系统检查做完窗口才出现",
      "以前 probe_available() 要读 src/main.rs，那个 `probe` 很慢",
    );
    expect(codesOf(md)).toContain("CODE_SYMBOL");
  });

  it("写了 ### 技术细节 这类小节 → UNKNOWN_SECTION（不再静默丢弃）", () => {
    const md = `${GOOD}\n### 技术细节\n- 这里写的内容以前会被跳过\n`;
    expect(codesOf(md)).toContain("UNKNOWN_SECTION");
  });

  it("只留空标题没有任何条目 → NO_ITEMS + EMPTY_SECTION", () => {
    const md = "## [Unreleased]\n\n### 更新摘要\n断网时打开软件不再卡住，检查更新也不会一直转圈。\n\n### 修复\n";
    const codes = codesOf(md);
    expect(codes).toContain("NO_ITEMS");
    expect(codes).toContain("EMPTY_SECTION");
  });

  it("亮点写了正文完全没有的结论 → 给警告（不拦）", () => {
    const md = GOOD.replace(
      "- **检查更新不再一直转圈**：断网时顶栏的小圆圈以前会转好几分钟，现在最多等一分钟就会告诉你没连上，可以再点一次重试。",
      "- **拖动窗口时光标不再停止闪烁**：透明主题下拖窗也不再闪动，这个结论还没验证过。",
    );
    const result = validate(parseNotes(md));
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain("UNBACKED_HIGHLIGHT");
  });
});

describe("发版数据流（release.mjs 用的那套解析）", () => {
  it("产出新版本段时保留亮点与摘要，且不夹带 git 提交标题", () => {
    const parsed = parseNotes(GOOD);
    const sections = collectItemSections(parsed);
    const highlightBlock = parsed.highlights.length
      ? `### 亮点\n${parsed.highlights.map((h) => `- ${h.text}`).join("\n")}\n\n`
      : "";
    const sectionLines = Object.entries(sections)
      .map(([name, items]) => `### ${name}\n${items.join("\n")}`)
      .join("\n\n");
    const block = `## [3.1.6] - 2026-11-11\n\n${highlightBlock}### 更新摘要\n${parsed.summary}\n\n${sectionLines}\n\n`;
    expect(block).toContain("### 亮点");
    expect(block).toContain("### 更新摘要");
    expect(block).toContain("断网时打开软件、检查更新");
    expect(block).not.toMatch(/^- (feat|fix|chg|docs|chore):/m);
    expect(block).not.toContain("版本更新");
    expect(validate(parseNotes(block, { stage: "latest" })).errors).toEqual([]);

    // 完整模拟 release.mjs 的第 4 步：删掉 Unreleased、把新段插到首个版本段之前
    const rest = removeUnreleased(`${GOOD}\n## [3.1.5] - 2026-11-10\n\n### 修复\n- 旧版条目\n`);
    const firstVer = rest.match(/^##\s+\[/m);
    const finalMd = rest.slice(0, firstVer.index) + block + rest.slice(firstVer.index);
    expect(finalMd).not.toContain("[Unreleased]");
    expect(finalMd.indexOf("## [3.1.6]")).toBeLessThan(finalMd.indexOf("## [3.1.5]"));
    expect(finalMd).toContain("旧版条目");
    expect(validate(parseNotes(finalMd, { stage: "latest" })).errors).toEqual([]);
  });
});

describe("CLI 退出码", () => {
  it("坏文案让进程退出码非 0，并在输出里给行号和改写建议", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ccb-notes-"));
    const file = path.join(dir, "CHANGELOG.md");
    const bad = GOOD.replace(
      "断网时打开软件、检查更新和连接页面都不再长时间卡住；从别的窗口点一下顶栏，窗口也不会跟着鼠标跑。",
      "v3.1.6 版本更新",
    );
    writeFileSync(file, bad, "utf-8");
    const script = fileURLToPath(new URL("./check-release-notes.mjs", import.meta.url));
    let output = "";
    let failed = false;
    try {
      execFileSync(process.execPath, [script, "--file", file], {
        encoding: "utf-8", stdio: "pipe",
      });
    } catch (e) {
      failed = true;
      output = `${e.stdout || ""}${e.stderr || ""}`;
    }
    rmSync(dir, { recursive: true, force: true });
    expect(failed).toBe(true);
    expect(output).toContain("PLACEHOLDER_SUMMARY");
    expect(output).toContain("CHANGELOG.md:");
    expect(output).toContain("→");
  });
});
