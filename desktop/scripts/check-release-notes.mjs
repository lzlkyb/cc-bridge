#!/usr/bin/env node
/**
 * 更新日志用户向门禁（check-release-notes.mjs）
 *
 * 为什么有这个脚本（2026-11-10）：`release.mjs` 原来把 git log 的提交标题按前缀
 * 分类，直接塞进 CHANGELOG 当「更新内容」。v3.1.2 与 v3.1.5 两次发版都因此产出
 * 「docs: 补充变更与归档」这类只有开发者看得懂的干条目，还和手写条目重复；
 * 非 TTY 环境下摘要又恒为占位文案「vX.Y.Z 版本更新」。每次都靠发版后手工
 * amend 重写，等于规则靠人记。这里把它变成机器闸：写得不合规就发不出去。
 *
 * ── 写作规范（用户向，小白能看懂）──────────────────────────────────
 * 1. 说「你会遇到什么」，不说「我们改了哪段代码」。
 * 2. 说「以前怎样、现在怎样」，让用户能对上自己的经历。
 * 3. 专有名词换成日常说法：系统检查 / 背后的检查 / 打开软件，而不是
 *    PowerShell、主线程、阻塞、tokio。实在必须提功能名（如「防火墙」），
 *    后面要跟一句「它是干什么的」。
 * 4. 一条只说一件事，别把三个改动塞一句里。
 * 5. 每条写成 `- **用户会看到的变化**：一句话`。标题是「读者扫一眼就知道
 *    自己会不会碰到」的那层信息，不是功能名、不是 bug 名。整条不超过 80 字。
 * 6. 光靠词表拦不住回归：黑名单永远追不上新说法，而长句 + 无标题几乎必然
 *    意味着「塞了多件事」或「在写技术论证」。所以第 4、5 条是硬闸，不靠人记。
 *
 * 坏（真实反例，v3.1.5 原稿）：
 *   - 断网时启动不再卡到「未响应」。防火墙能力探测原先在窗口显示之前、
 *     主线程上同步跑一个 PowerShell，断网环境下没有超时可等几十秒……
 * 好（同一件事，小白版）：
 *   - **断网时打开软件不再卡住**：以前要等一项系统检查做完，窗口才出现；
 *     断网时这一步可能一直等不到结果。现在窗口先打开，检查放在背后做。
 *
 * ── 用法 ──────────────────────────────────────────────────────────
 *   node scripts/check-release-notes.mjs                 # 校验 [Unreleased]
 *   node scripts/check-release-notes.mjs --stage=latest   # 校验最新已发布段（pre-push 用）
 *   node scripts/check-release-notes.mjs --file <path>     # 指定文件（测试用）
 *
 * 棘轮：新规从 MIN_STRICT_VERSION 起生效，之前已发布的版本段豁免——否则
 * 历史技术向文案会把之后的每一次 push 都卡死。只许往后加，不许调低。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(__dirname, "..");
const DEFAULT_CHANGELOG = path.resolve(DESKTOP, "..", "CHANGELOG.md");

/** 从此版本起才启用严格规则；更早的已发布段是历史，不回头改。 */
export const MIN_STRICT_VERSION = "3.1.6";

/** 允许出现在发布说明里的小节。写别的名字会被拦下，避免内容被静默丢掉。 */
const ITEM_SECTIONS = new Set(["新增", "变更", "修复", "优化", "安全", "改进"]);
const META_SECTIONS = new Set(["更新标语", "更新摘要", "亮点", "Highlights"]);

/** 一眼就知道是开发者术语的词。命中即拦，报错里给替换建议。 */
const HARD_TECH = [
  "tauri", "wry", "tao", "tokio", "powershell", "netsh", "cmd", "cargo",
  "clippy", "rustfmt", "rust", "vite", "vitest", "eslint", "tsc", "webpack",
  "webview2", "json", "yaml", "toml", "api", "sdk", "cli", "tty", "tcp",
  "udp", "http", "https", "smb", "dll", "uac", "csp", "dpi", "async",
  "spawn_blocking", "start_dragging", "dispatcher", "handler", "fallback",
  "endpoint", "deadline", "refactor", "commit", "git log", "github actions",
  "主线程", "线程池", "阻塞", "异步", "轮询", "代码页", "编译", "反序列化",
  "钩子", "监听器", "冷启动", "帧级", "内核", "驱动", "环境变量", "注册表",
];

/** 用户多半能猜到，但更好换成日常说法。只提醒，不拦。 */
const SOFT_TECH = ["脚本", "进程", "插件", "模块", "缓存", "端口", "依赖", "构建", "接口", "日志级别"];

/** 一看就是占位 / 提交标题 / 敷衍话，不该出现在发布说明里。 */
const PLACEHOLDERS = [
  /^v?\d+(\.\d+){1,3}\s*版本更新$/i,
  /版本更新$/,
  /^见\s*git\s*提交历史$/i,
  /^(待补充|TODO|TBD|同上|略|若干|优化若干|修复若干)$/i,
  /(修复|优化|新增|调整|解决)[^\n]{0,6}若干/,
];
const COMMIT_PREFIX = /^(feat|fix|chg|change|refactor|docs|chore|perf|sec|test|style|build|ci)(\([^)]*\))?\s*[:：]/i;

/**
 * 条目形状：`- **用户会看到的变化**：一句话`。
 * 这里只认形状，标题长短另行判断（分开判才能给出「标题太长」这种准话）。
 */
const TITLED_ITEM = /^\*\*([^*]+)\*\*\s*[：:]\s*(\S[\s\S]*)$/;

/** 标题上限：超过这个长度就变成第二句正文了，扫视时看不出主题。 */
const MAX_TITLE_LEN = 24;

/** 标题只写这些词 = 没写标题，读者扫一眼还是不知道发生了什么。 */
const HOLLOW_TITLES = new Set([
  "优化", "改进", "调整", "更新", "修复", "其他", "其它", "杂项", "若干",
  "细节", "小改", "问题", "问题修复", "体验优化", "性能优化", "已知问题",
  "其他改动", "一些改进", "多处优化", "各种修复",
]);

/**
 * 一条超过这个长度，几乎必然塞了不止一件事，或者在做技术论证。
 * v3.1.5 的条目一条 110~160 字、一句里塞四个超时值，就是这条规则要拦的形状。
 */
const MAX_ITEM_LEN = 80;

/** 用户可感知的动词/现象词。一条都没有时给个「从现象写起」的提醒。 */
const USER_WORDS = [
  "不再", "现在", "以前", "会", "不会", "可以", "打开", "点击", "显示", "提示",
  "卡住", "转圈", "失败", "找不到", "自动", "记住", "选", "看到", "输入", "连接",
  "拖", "变成", "省", "快", "慢", "一键", "不用", "多", "少", "丢", "出错",
];

/** 亮点与正文做「有没有依据」比对时，这些常见词不算证据。 */
const STOP_WORDS = new Set([
  "不再", "现在", "可以", "不会", "以前", "这个", "那个", "我们", "软件",
  "窗口", "时候", "问题", "以后", "一次", "一直", "直接", "自动", "提示",
  "显示", "点击", "打开", "使用", "页面", "版本", "更新", "操作",
]);

const norm = (s) => s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
const clean = (s) => s.replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();

/** 返回文本里命中的开发者术语（英文按词边界，中文按包含）。 */
export function findTechTerms(text) {
  const hits = [];
  for (const word of HARD_TECH) {
    const ascii = [...word].every((ch) => ch.charCodeAt(0) < 128);
    const re = ascii
      ? new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
      : null;
    if (re) {
      const m = text.match(re);
      if (m) hits.push(m[0]); // 保留原文大小写，报错里更好认
    } else if (text.includes(word)) {
      hits.push(word);
    }
  }
  return hits;
}

/** 代码符号：反引号、foo.bar()、run_command()、xxx.rs、src/ 路径。 */
export function findCodeSymbols(text) {
  const hits = [];
  if (text.includes("`")) hits.push("反引号代码");
  if (/\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/.test(text)) hits.push("点号标识符");
  if (/\b[A-Za-z_][A-Za-z0-9_]*\(\)/.test(text)) hits.push("函数调用");
  if (/\.(rs|ts|tsx|mjs|js|json|yml|yaml|toml|exe|dll)\b/i.test(text)) hits.push("文件名");
  if (/\b(src|scripts|desktop|node_modules)\//.test(text)) hits.push("源码路径");
  return hits;
}

/**
 * 剥掉 HTML 注释，但**逐行保留占位**（空串）。
 *
 * 后面所有报错都靠 `i + 1` 报文件真实行号，删行会让定位全部错位，所以只清空不清除。
 * CHANGELOG 顶部那段「写法」说明就是注释：不剥掉会被当成上一条条目的续行并进去
 * ——实测把 319 字的说明算成了一条「修复」，还因为它提到 PowerShell 被判成黑话。
 */
function stripHtmlComments(lines) {
  const out = lines.slice();
  let inComment = false;
  for (let i = 0; i < out.length; i++) {
    let rest = out[i];
    let kept = "";
    while (rest !== "") {
      if (inComment) {
        const end = rest.indexOf("-->");
        if (end < 0) break;
        rest = rest.slice(end + 3);
        inComment = false;
      } else {
        const start = rest.indexOf("<!--");
        if (start < 0) { kept += rest; break; }
        kept += rest.slice(0, start);
        rest = rest.slice(start + 4);
        inComment = true;
      }
    }
    out[i] = kept;
  }
  return out;
}

/**
 * 解析 CHANGELOG：找出目标段（[Unreleased] 或最新已发布版本），拆出小节与条目。
 * 每个条目带真实行号，报错能直接定位到文件某一行。
 */
export function parseNotes(md, { stage = "unreleased" } = {}) {
  const lines = stripHtmlComments(md.replace(/\r\n/g, "\n").split("\n"));
  let start = -1;
  let version = null;
  if (stage === "unreleased") {
    start = lines.findIndex((l) => /^##\s+\[Unreleased\]/.test(l));
  } else {
    const re = /^##\s+\[(\d+\.\d+\.\d+)\]\s+-\s+\S+/;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) { start = i; version = m[1]; break; }
    }
  }
  if (start < 0) {
    return { stage, version, found: false, startLine: 0, sections: [], summary: "", highlights: [] };
  }

  const sections = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+\[/.test(line)) break;
    const sec = line.match(/^###\s+(.+)$/);
    if (sec) {
      current = { name: sec[1].trim(), line: i + 1, items: [] };
      sections.push(current);
      continue;
    }
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (item && current) {
      // raw 保留原始 markdown（含 `**` 粗体），text 是去掉标记的纯文本。
      // 结构规则要看 raw，黑话/长度规则看 text；发版时写回 CHANGELOG 也必须用
      // raw，否则 `**标题**` 会被剥成纯文本——新规则一发布就被自己破坏。
      const raw = item[1].trim();
      current.items.push({ text: clean(raw), raw, line: i + 1 });
      continue;
    }
    // 摘要是裸文本；条目写到第二行时把续行并回条目本身——否则换行处后面的
    // 黑话 / 代码符号会逃过检查，而 gen-changelog.mjs 又是合并续行的。
    if (current && line.trim() && !line.startsWith("###")) {
      const last = current.items[current.items.length - 1];
      if (last) {
        last.text = clean(`${last.text} ${line.trim()}`);
        last.raw = `${last.raw} ${line.trim()}`;
      } else {
        current.freeText = (current.freeText || []).concat({ text: line.trim(), line: i + 1 });
      }
    }
  }

  const summarySec = sections.find((s) => s.name === "更新摘要");
  const summary = summarySec?.freeText?.map((f) => f.text).join(" ").trim()
    || summarySec?.items?.map((i) => i.text).join(" ").trim()
    || "";
  const highlightSec = sections.find((s) => s.name === "亮点" || s.name === "Highlights");
  const highlights = highlightSec?.items || [];

  return {
    stage, version, found: true, startLine: start + 1,
    sections, summary, highlights,
  };
}

/** 把解析结果按规则过一遍。errors 会拦下发版，warnings 只提醒。 */
export function validate(parsed) {
  const errors = [];
  const warnings = [];
  const add = (line, section, code, message, hint) =>
    errors.push({ line, section, code, message, hint });

  if (!parsed.found) {
    add(1, "文件", "MISSING_SECTION",
      parsed.stage === "unreleased"
        ? "找不到 ## [Unreleased] 段"
        : "找不到已发布的版本段（## [x.y.z] - 日期）",
      "发版前先在 CHANGELOG.md 顶部写好本版内容：## [Unreleased] → ### 亮点 → ### 更新摘要 → ### 修复/变更。");
    return { errors, warnings };
  }

  if (parsed.stage === "latest" && parsed.version && compareVersion(parsed.version, MIN_STRICT_VERSION) < 0) {
    return { errors, warnings, skipped: `v${parsed.version} 是历史版本，按棘轮豁免` };
  }

  const names = parsed.sections.map((s) => s.name);
  if (!names.includes("更新摘要")) {
    add(parsed.startLine, "更新摘要", "MISSING_SUMMARY", "缺少 ### 更新摘要",
      "写一句大白话，例如：「断网时打开软件不再卡住，检查更新也不会一直转圈。」这一句会显示在更新弹框和 Release 页面。");
  }
  for (const s of parsed.sections) {
    if (!ITEM_SECTIONS.has(s.name) && !META_SECTIONS.has(s.name)) {
      add(s.line, s.name, "UNKNOWN_SECTION", `不认识的小节「### ${s.name}」`,
        `发布说明只认：${[...ITEM_SECTIONS].join(" / ")}，外加「更新标语」「亮点」「更新摘要」。写别的小节会被静默丢掉，所以这里直接拦下。`);
    }
  }

  // 摘要：单行、够长、不是占位、没有黑话
  if (parsed.summary) {
    const sumSec = parsed.sections.find((s) => s.name === "更新摘要");
    const sumLine = sumSec?.line || parsed.startLine;
    const freeLines = sumSec?.freeText?.length || 0;
    if (freeLines > 1) {
      add(sumLine, "更新摘要", "MULTILINE_SUMMARY", "更新摘要写成了多行",
        "摘要只要一句大白话，一行写完；细节放到下面的「修复 / 变更」里。");
    }
    if (parsed.summary.length < 12 || parsed.summary.length > 160) {
      add(sumLine, "更新摘要", "BAD_SUMMARY_LENGTH",
        `摘要 ${parsed.summary.length} 字，太短或太长`,
        "写成 12～160 字的一句人话：说清「这次升级对你有什么变化」。");
    }
    if (PLACEHOLDERS.some((re) => re.test(parsed.summary)) || /^v?\d+\.\d+\.\d+/.test(parsed.summary)) {
      add(sumLine, "更新摘要", "PLACEHOLDER_SUMMARY", "摘要是占位文案或版本号",
        "别写「v3.1.6 版本更新」，写用户能看懂的结果，例如「断网时打开软件不再卡住」。");
    }
    checkUserFacing(parsed.summary, sumLine, "更新摘要", add, warnings);
  }

  // 条目：提交标题 / 占位 / 太短 / 重复 / 黑话 / 代码符号
  const seen = new Map();
  const itemSections = parsed.sections.filter((s) => ITEM_SECTIONS.has(s.name));
  const highlightItems = parsed.highlights;
  let itemCount = 0;
  for (const s of itemSections) {
    if (!s.items.length) {
      add(s.line, s.name, "EMPTY_SECTION", `### ${s.name} 下面一条内容都没有`,
        "没有内容就删掉这个小节，别留空标题。");
    }
    for (const item of s.items) {
      itemCount++;
      checkItem(item, s.name, add, warnings);
      const key = norm(item.text);
      if (key && seen.has(key)) {
        add(item.line, s.name, "DUPLICATE_ITEM", `与第 ${seen.get(key)} 行内容重复`,
          "同一件事只写一次；别让 git 提交标题和手写说明同时出现在发布说明里。");
      } else if (key) {
        seen.set(key, item.line);
      }
    }
  }
  for (const item of highlightItems) checkItem(item, "亮点", add, warnings);

  if (itemCount === 0) {
    add(parsed.startLine, "文件", "NO_ITEMS", "没有任何「修复 / 变更 / 新增」条目",
      "至少写一条用户能感知的变化，否则这次发版没有内容可发布。");
  }

  // 亮点里若出现正文完全没有的词，可能是没验证过的结论（只提醒，不拦）
  const bodyText = itemSections.flatMap((s) => s.items.map((i) => i.text)).join("");
  for (const h of highlightItems) {
    const chunks = h.text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    // 只命中一个常见词不算「有依据」：像「拖动」这种词几乎总会碰巧出现。
    const matched = new Set();
    for (const c of chunks) {
      for (let i = 0; i + 2 <= c.length; i++) {
        const pair = c.slice(i, i + 2);
        if (!STOP_WORDS.has(pair) && bodyText.includes(pair)) matched.add(pair);
      }
    }
    if (matched.size < 2) {
      warnings.push({ line: h.line, section: "亮点", code: "UNBACKED_HIGHLIGHT",
        message: "这条亮点在下面的正文条目里找不到对应内容，确认它不是没验证过的结论" });
    }
  }
  return { errors, warnings };
}

function checkItem(item, section, add, warnings) {
  const { text, line } = item;
  const raw = item.raw ?? text;
  const isCommitTitle = COMMIT_PREFIX.test(text);
  if (isCommitTitle) {
    add(line, section, "COMMIT_TITLE", "这条是 git 提交标题，不是给用户看的说明",
      "去掉 feat:/fix:/chg: 这类前缀，改成「以前会遇到什么、现在变成什么」。提交标题留在 git 里就好。");
  } else {
    // 形状：`- **用户会看到的变化**：一句话`。这是「扫一眼能不能看懂」的唯一
    // 可测代理——黑名单追不上新黑话，但没标题、写成一坨的条目一眼就能抓出来。
    const titled = raw.match(TITLED_ITEM);
    if (!titled) {
      add(line, section, "UNTITLED_ITEM", "这条没有写成「标题：说明」的形状",
        "改成 `- **用户会看到的变化**：以前怎样，现在怎样。`，例如 "
        + "`- **断网后旧隧道占着地址**：断线约 45 秒后自动释放，重连沿用原地址。`");
    } else {
      const title = titled[1].trim();
      const titleLen = [...title].length;
      if (titleLen > MAX_TITLE_LEN) {
        add(line, section, "TITLE_TOO_LONG", `标题 ${titleLen} 字，超过 ${MAX_TITLE_LEN} 字`,
          "标题只写「读者一眼能对上自己经历」的那句话，其余内容放到冒号后面。");
      } else if (HOLLOW_TITLES.has(title)) {
        add(line, section, "HOLLOW_TITLE", `标题「${title}」等于没写标题`,
          "换成具体现象，例如把「优化」写成「接入卡更紧凑」、把「修复」写成「复制出的地址不一致」。");
      }
    }
  }
  if (PLACEHOLDERS.some((re) => re.test(text))) {
    add(line, section, "PLACEHOLDER_ITEM", "这条是占位 / 敷衍文案",
      "写具体变化，例如「导出文件时可以自己选保存位置，不再悄悄存进下载目录」。");
  }
  const len = [...text].length;
  if (len < 10) {
    add(line, section, "TOO_SHORT", `只有 ${len} 个字，说不清是什么变化`,
      "补一句：以前怎样、现在怎样、对你有什么影响。至少 10 个字。");
  }
  if (len > MAX_ITEM_LEN) {
    add(line, section, "TOO_LONG", `${len} 字，超过 ${MAX_ITEM_LEN} 字上限`,
      "超长通常意味着一条塞了多件事，或者在写实现细节。拆成两条；"
      + "删掉「本机实测 1.4 秒」「netsh 查询 3 秒」这类论证，只留以前怎样、现在怎样。");
  }
  checkUserFacing(text, line, section, add, warnings);
  const soft = SOFT_TECH.filter((w) => text.includes(w));
  if (soft.length) {
    warnings.push({ line, section, code: "SOFT_TECH",
      message: `用了「${soft.join("、")}」，可以考虑换成更日常的说法` });
  }
  if (!USER_WORDS.some((w) => text.includes(w))) {
    warnings.push({ line, section, code: "NO_USER_WORD",
      message: "没看到「以前 / 现在 / 会 / 不再」这类说法，试着从用户会遇到的事写起" });
  }
}

function checkUserFacing(text, line, section, add, warnings) {
  const tech = findTechTerms(text);
  if (tech.length) {
    add(line, section, "TECH_TERM", `含开发者术语「${tech.join("、")}」，小白看不懂`,
      "换成日常说法：PowerShell→「一项系统检查」、主线程→「打开软件时」、阻塞→「一直等」；实在要提功能名，后面补一句它是干什么的。");
  }
  const symbols = findCodeSymbols(text);
  if (symbols.length) {
    add(line, section, "CODE_SYMBOL", `含代码符号（${symbols.join("、")}）`,
      "发布说明里不要写文件名、函数名、反引号代码；那些属于提交记录。");
  }
  if (/\[[^\]]+\]\([^)]+\)/.test(text) || /https?:\/\//.test(text)) {
    warnings.push({ line, section, code: "LINK", message: "含链接，更新弹框里可能点不开，尽量去掉" });
  }
}

export function compareVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 从 md 里删除 [Unreleased] 整段，供 release.mjs 消费后重写。 */
export function removeUnreleased(md) {
  return md.replace(/^##\s+\[Unreleased\][\s\S]*?(?=\n##\s+\[|$(?![\s\S]))\n?/m, "");
}

/**
 * 发版后要重新长出来的 [Unreleased] 空骨架（含写法注释）。
 *
 * 🔴 为什么要有这个常量（2026-11-18 v3.2.2 实测踩坑）：`removeUnreleased` 会把整个
 * ## [Unreleased] 段连写法注释一起删干净，旧版 release.mjs 只往里插新版本段、没有
 * 任何一步重建骨架，于是发版后文件里再无 [Unreleased]。后果是**静默**的：pre-push
 * 只校验「最新已发布段」（--stage=latest），不会发现少了一段，直到下一轮要写更新
 * 说明时才发现没地方写，只能临时手工补。骨架与注释统一由这里产出，release 与测试
 * 共用同一份，避免「脚本里一份、文件里另一份」的漂移。
 */
export const UNRELEASED_TEMPLATE = `## [Unreleased]

<!-- 写法（发版前会硬查，不合规直接中止）。这段注释由脚本自动重建，不用手删：
     每条 = 短标题 + 冒号 + 一句话。标题写「读者一眼能对上自己经历」的那句话（≤24 字），
     不能是「优化 / 修复 / 调整」这类空壳词，也别只写功能名；冒号后面说清以前怎样、现在怎样。
     一条只说一件事，整条不超过 80 字。不写 PowerShell、主线程、反引号代码、文件名、feat: 前缀。
     更新摘要只写一句大白话（12~160 字），它会显示在更新弹框和 Release 页面。 -->

`;

/**
 * 把「消费掉旧 [Unreleased]」与「重建新骨架 + 插入新版本段」合成一步。
 *
 * 顺序固定为：文件头 → 空 [Unreleased] 骨架 → 新版本段 → 历史版本段。
 * 新版本段必须落在首个 `## [` 之前，否则解析器按 `## [x.y.z]` 分段时它不属于任何版本。
 */
export function applyRelease(md, versionBlock) {
  const rest = removeUnreleased(md);
  const firstVer = rest.match(/^##\s+\[/m);
  const head = firstVer && firstVer.index !== undefined ? rest.slice(0, firstVer.index) : rest;
  const tail = firstVer && firstVer.index !== undefined ? rest.slice(firstVer.index) : "";
  return `${head}${UNRELEASED_TEMPLATE}${versionBlock}${tail}`;
}

/**
 * 落盘前的形状自检：骨架必须存在、唯一，且排在新版本段之前。
 * 返回 null 表示合格，否则返回一句给人看的错因。release.mjs 拿它当硬闸。
 */
export function checkReleaseShape(md, version) {
  const heads = md.match(/^##\s+\[Unreleased\]/gm) ?? [];
  if (heads.length !== 1) {
    return `发版后应恰好有 1 个 ## [Unreleased]，实际 ${heads.length} 个（骨架没重建或被重复插入）`;
  }
  const unreleasedAt = md.search(/^##\s+\[Unreleased\]/m);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versionAt = md.search(new RegExp(`^##\\s+\\[${escaped}\\]`, "m"));
  if (versionAt < 0) return `发版后找不到 ## [${version}] 版本段`;
  if (unreleasedAt > versionAt) return `## [Unreleased] 必须排在新版本段 ## [${version}] 之前`;
  return null;
}

/** 把 [Unreleased] 的小节转成 release.mjs 需要的 { 小节名: ["- 条目"] }。 */
export function collectItemSections(parsed) {
  const out = {};
  for (const s of parsed.sections) {
    if (ITEM_SECTIONS.has(s.name) && s.items.length) {
      // 用 raw 而不是 text：`**标题**` 的粗体是结构的一部分，发版时必须原样
      // 搬到新版本段。早期版本这里用 text，于是下一次发版会把标题式条目静默
      // 剥成纯文本——新规则刚发布就被发版脚本自己破坏。
      out[s.name] = s.items.map((i) => `- ${i.raw ?? i.text}`);
    }
  }
  return out;
}

/**
 * 把解析好的 [Unreleased] 渲染成一个已发布版本段。
 * release.mjs 与测试共用这一份，避免测试复制粘贴逻辑后与真实发版路径走偏。
 */
export function renderVersionBlock(parsed, version, date) {
  const taglineSection = parsed.sections.find(s => s.name === "更新标语");
  const tagline = [...(taglineSection?.freeText ?? []), ...(taglineSection?.items ?? [])].map(item => item.text).join(" ").trim();
  const taglineBlock = tagline ? `### 更新标语\n${tagline}\n\n` : "";
  const highlights = parsed.highlights.map((h) => `- ${h.raw ?? h.text}`);
  const highlightBlock = highlights.length
    ? `### 亮点\n${highlights.join("\n")}\n\n`
    : "";
  const sectionLines = Object.entries(collectItemSections(parsed))
    .map(([name, items]) => `### ${name}\n${items.join("\n")}`)
    // 两个 \n：单个 \n 会让下一个 "###" 紧贴列表项，Markdown 渲染成一整段。
    .join("\n\n");
  return `## [${version}] - ${date}\n\n${taglineBlock}${highlightBlock}### 更新摘要\n${parsed.summary}\n\n${sectionLines}\n\n`;
}

export function formatReport(result, filePath) {
  const out = [];
  if (result.skipped) {
    out.push(`[更新日志] ${result.skipped}，跳过检查。`);
    return out.join("\n");
  }
  for (const e of result.errors) {
    out.push(`  ✗ ${path.basename(filePath)}:${e.line} [${e.section}] ${e.message}（${e.code}）`);
    out.push(`      → ${e.hint}`);
  }
  for (const w of result.warnings) {
    out.push(`  ! ${path.basename(filePath)}:${w.line} [${w.section}] ${w.message}`);
  }
  if (!result.errors.length && !result.warnings.length) {
    out.push("  ✅ 更新日志是用户向文案，没有发现占位、提交标题或开发者黑话。");
  }
  return out.join("\n");
}

/** CLI：任何 error 都以非 0 退出，让 release / pre-push 直接失败。 */
export function main(argv = process.argv.slice(2)) {
  const fileArg = argv.indexOf("--file");
  const filePath = fileArg >= 0 ? path.resolve(argv[fileArg + 1]) : DEFAULT_CHANGELOG;
  const stage = argv.includes("--stage=latest") ? "latest" : "unreleased";
  const md = fs.readFileSync(filePath, "utf-8");
  const parsed = parseNotes(md, { stage });
  const result = validate(parsed);
  console.log(`[更新日志] 检查 ${path.basename(filePath)}（${stage === "latest" ? "最新发布段" : "[Unreleased]"}）`);
  console.log(formatReport(result, filePath));
  if (result.errors.length) {
    console.error(`\n共 ${result.errors.length} 处不合规，已拦下。改好上面的条目再发版。`);
    process.exitCode = 1;
  }
  return result.errors.length === 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
