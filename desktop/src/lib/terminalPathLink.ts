import type { Terminal, ILinkProvider, ILink } from "@xterm/xterm";

/**
 * 终端输出里的**远端绝对路径** → 可点击（P1 ⑦，cc-bridge 差异化）。
 *
 * 点击 → `onOpenPath(path)` → 父级打开该连接的 SSH 文件浏览器并定位（文件则定位到
 * 其父目录）。别的终端只能拿路径开本地编辑器，我们有 SFTP 浏览器，这一步是白捡的。
 *
 * 匹配规则（宁缺毋滥，误报比漏报烦人）：
 * - 必须以 `/` 开头（绝对路径）；相对路径、`~/x` 不碰——前者歧义大，后者要拿 cwd 展开；
 * - 字符集是 **Unicode 字母/数字**（`\p{L}\p{N}`）+ `_.@+-`：远端路径的绝大多数。
 *   🔴 早先只认 `[A-Za-z0-9_.@+-]`，于是 `/var/日志/app.log`、`/home/张三/x` 这类
 *   中文路径一整段都点不动——中文目录名恰恰是本用户群最常见的场景；
 * - 含**空格**的路径只认带引号的形式（`'/srv/my file.txt'`）：终端里 `ls` 默认就会给
 *   这种名字加引号。裸文本里的空格没法跟「路径后面跟句话」区分，硬放开会把
 *   `see /var/log for details` 整句吃成一条路径；
 * - lookbehind 排除 URL（前一个字符是 `:` 或路径字符：`http://host/x`、`//host/x`、
 *   `build/thing`）；
 * - 尾部剥掉 `.,;:)` 类标点——句尾路径不应把句点当文件名。
 *
 * 局限（有意为之，P1 范围）：只匹配**单行内**的路径。被终端折行截断的长路径匹配
 * 不到完整形态（官方 web-links addon 做了跨行拼接 + 宽字符映射，复杂度不小，先不做）。
 */

/** 路径片段允许的字符（字符类内容，注意别在这里放会破坏字符类的字符）。 */
const SEG = "\\p{L}\\p{N}_.@+\\-";

// 未加引号的绝对路径。两条 lookbehind 各挡一类误报：
// - `(?<!\/)`：`//host/x` 协议相对地址；
// - `(?<![SEG])`：绝对路径的 `/` 在终端输出里几乎不会紧跟在路径字符后面——URL 深层路径
//   （`host/var/www` 的 /var、/www）、相对路径中段（`build/thing`）全被挡掉。
// ⚠️ scp 风格的 `host:/srv/x` 前面是冒号，放行（这是想要的可点击路径）。
const BARE_RE = new RegExp(`(?<!\\/)(?<![${SEG}])(\\/(?:[${SEG}]+\\/?)+)`, "gu");

/** 引号包裹的整串（`ls` 对含空格/特殊字符的名字会这样输出）。 */
const QUOTED_RE = /'([^'\n]{2,}?)'|"([^"\n]{2,}?)"/g;

/** 尾部标点剥离（文件名尾部句点在 Unix 合法但罕见，句子结尾更常见）。 */
const TRAILING_PUNCT = /[.,;:)\]}'"]+$/;

export interface PathMatch {
  path: string;
  /** 0-based 字符列起点（调用方负责换算成 xterm 的 1-based cell 列）。 */
  startCol: number;
  length: number;
}

/**
 * 重叠消解：引号形式通常包住整条路径，比被空格截断的裸匹配更完整，重叠时留长的。
 * 两者起点可能相同（都指向 `/`），所以先按起点升序、再按长度降序。
 */
function dedupe(list: PathMatch[]): PathMatch[] {
  list.sort((a, b) => a.startCol - b.startCol || b.length - a.length);
  const out: PathMatch[] = [];
  for (const m of list) {
    const last = out[out.length - 1];
    if (last && m.startCol < last.startCol + last.length) {
      if (m.length > last.length) out[out.length - 1] = m;
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * 从一行终端文本里找出绝对路径。纯函数，配单测。
 * 返回的 path 已剥尾部标点；startCol/length 对应**剥后的**匹配。
 */
export function findPathsInLine(text: string): PathMatch[] {
  if (!text.includes("/")) return [];
  const found: PathMatch[] = [];
  BARE_RE.lastIndex = 0;
  for (let m = BARE_RE.exec(text); m; m = BARE_RE.exec(text)) {
    // 剥尾部标点后仍要至少两字符（"/x" 也算，单字符 "/" 是根目录不是链接目标）。
    const path = m[1].replace(TRAILING_PUNCT, "");
    if (path.length < 2) continue;
    found.push({ path, startCol: m.index, length: path.length });
  }
  QUOTED_RE.lastIndex = 0;
  for (let m = QUOTED_RE.exec(text); m; m = QUOTED_RE.exec(text)) {
    const raw = m[1] ?? m[2] ?? "";
    // 只认绝对路径；`//host` 是协议相对地址，不碰。
    if (raw.length < 2 || !raw.startsWith("/") || raw.startsWith("//")) continue;
    const path = raw.replace(TRAILING_PUNCT, "");
    if (path.length < 2) continue;
    // startCol 指向引号**内**的路径本体：下划线只覆盖路径，不含引号。
    found.push({ path, startCol: m.index + 1, length: path.length });
  }
  return dedupe(found);
}

/** 只取换算要用的两个方法（`IBufferCell` 全量实现太宽，测试里也不好造假）。 */
interface LinkCell {
  getWidth(): number;
  getChars(): string;
}
interface LinkLine {
  length: number;
  getCell(x: number): LinkCell | undefined;
}

/**
 * 字符下标 → 终端列（1-based）。
 *
 * 🔴 必须换算，不能拿字符串下标当列号：`translateToString` 的下标按 UTF-16 码元数，
 * 而 `ILink.range` 按单元格宽度算——中日韩字符占两列，`/var/日志/x` 的字符数与列数
 * 不相等，直接用下标会让下划线与可点区域错位（路径后半段点不到）。
 * 宽字符的第二个单元格 `getWidth() === 0` 且 `getChars()` 为空，不贡献字符。
 */
export function cellColumnOf(line: LinkLine, charIndex: number): number {
  let chars = 0;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    // 宽字符的第二格是零宽占位，不属于任何字符——必须先跳过再判边界，
    // 否则「字符边界恰好落在这里」时会返回占位列，下划线短一格。
    if (cell && cell.getWidth() === 0) continue;
    if (chars >= charIndex) return x + 1;
    chars += cell ? (cell.getChars() || " ").length : 1;
  }
  return line.length + 1;
}

/**
 * 给终端挂上「路径可点击」。返回 dispose。
 * 与 @xterm/addon-web-links 并存：registerLinkProvider 支持多个 provider 按注册顺序询问，
 * 我们的 provider 注册在 web-links 之后（attach 顺序由调用方保证），URL 仍归 web-links。
 */
export function registerPathLinkProvider(
  term: Terminal,
  onOpenPath: (path: string) => void,
): () => void {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const links: ILink[] = findPathsInLine(text).map((m) => ({
        range: {
          start: { x: cellColumnOf(line, m.startCol), y: bufferLineNumber },
          end: { x: cellColumnOf(line, m.startCol + m.length) - 1, y: bufferLineNumber },
        },
        text: m.path,
        // activate 的 event/text/range 参数我们都用不上，箭头函数少参兼容。
        activate: () => onOpenPath(m.path),
      }));
      callback(links.length > 0 ? links : undefined);
    },
  };
  const disposable = term.registerLinkProvider(provider);
  return () => disposable.dispose();
}
