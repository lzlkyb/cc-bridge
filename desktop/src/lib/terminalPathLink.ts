import type { Terminal, ILinkProvider, ILink } from "@xterm/xterm";

/**
 * 终端输出里的**远端绝对路径** → 可点击（P1 ⑦，cc-bridge 差异化）。
 *
 * 点击 → `onOpenPath(path)` → 父级打开该连接的 SSH 文件浏览器并定位（文件则定位到
 * 其父目录）。别的终端只能拿路径开本地编辑器，我们有 SFTP 浏览器，这一步是白捡的。
 *
 * 匹配规则（宁缺毋滥，误报比漏报烦人）：
 * - 必须以 `/` 开头（绝对路径）；相对路径、`~/x` 不碰——前者歧义大，后者要拿 cwd 展开；
 * - 字符集限定 `[A-Za-z0-9_.@+-]`（远端路径的绝大多数；空格路径匹配不到，接受）；
 * - lookbehind 排除 URL（前一个字符是 `:` 或 `/`：`http://host/x`、`//host/x`）；
 * - 尾部剥掉 `.,;:)` 类标点——句尾路径不应把句点当文件名。
 *
 * 局限（有意为之，P1 范围）：只匹配**单行内**的路径。被终端折行截断的长路径匹配
 * 不到完整形态（官方 web-links addon 做了跨行拼接 + 宽字符映射，复杂度不小，先不做）。
 */

// 匹配绝对路径。两条 lookbehind 各挡一类误报：
// - `(?<!\/)`：`//host/x` 协议相对地址；
// - `(?<!\w)`：绝对路径的 `/` 在终端输出里几乎不会紧跟在字母后面——URL 深层路径
//   （`host/var/www` 的 /var、/www）、相对路径中段（`build/thing`）全被挡掉。
// ⚠️ scp 风格的 `host:/srv/x` 前面是冒号，放行（这是想要的可点击路径）。
const PATH_RE = /(?<!\/)(?<!\w)(\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*\/?)/g;

/** 尾部标点剥离（文件名尾部句点在 Unix 合法但罕见，句子结尾更常见）。 */
const TRAILING_PUNCT = /[.,;:)\]}'"]+$/;

export interface PathMatch {
  path: string;
  /** 0-based 字符列起点（调用方负责换算成 xterm 的 1-based cell 列）。 */
  startCol: number;
  length: number;
}

/**
 * 从一行终端文本里找出绝对路径。纯函数，配单测。
 * 返回的 path 已剥尾部标点；startCol/length 对应**剥后的**匹配。
 */
export function findPathsInLine(text: string): PathMatch[] {
  if (!text.includes("/")) return [];
  const out: PathMatch[] = [];
  PATH_RE.lastIndex = 0;
  for (let m = PATH_RE.exec(text); m; m = PATH_RE.exec(text)) {
    // 剥尾部标点后仍要至少两字符（"/x" 也算，单字符 "/" 是根目录不是链接目标）。
    const path = m[1].replace(TRAILING_PUNCT, "");
    if (path.length < 2) continue;
    out.push({ path, startCol: m.index, length: path.length });
  }
  return out;
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
          start: { x: m.startCol + 1, y: bufferLineNumber },
          end: { x: m.startCol + m.length, y: bufferLineNumber },
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
