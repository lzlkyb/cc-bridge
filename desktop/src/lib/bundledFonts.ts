/**
 * 内置字体：随安装包打包的 ttf（`src/assets/fonts/`），启动时用 FontFace API 注册进文档。
 *
 * WHY 打包而不是让用户自装：自装流程是「下载 → 认对变体 → 解压 → 安装 → 重启」，
 * 任何一步走错体验就崩；内置后开箱即用（行业惯例：Tabby 内置 Source Code Pro、
 * Windows Terminal 附带 Cascadia Code、Warp 默认 Hack）。
 *
 * WHY FontFace API 而不是 CSS `@font-face`：xterm 的 canvas 渲染器按 `document.fonts`
 * 里的已加载 FontFace 匹配 family，且 FontFace 能精确知道「全部加载完成」这个时点
 * （`@font-face` 做不到）——这个时点会广播出去，终端据此重新度量一次字形。
 *
 * 🔴 family 名必须与 `terminalFontFamily.ts` 字体栈里写的完全一致（空格与大小都算），
 * 对不上就是静默回退，内置等于白打。
 *
 * 时序：模块被 import 即开始加载（应用启动早期，远早于任何终端创建）。
 * 2 秒超时兜底——加载卡住也不能挂住任何等待方，失败只是回退到系统等宽字体，
 * 没那么好看但功能无损。
 */
import jetbrainsRegular from "../assets/fonts/jetbrains/JetBrainsMono-Regular.ttf";
import jetbrainsBold from "../assets/fonts/jetbrains/JetBrainsMono-Bold.ttf";
import jetbrainsItalic from "../assets/fonts/jetbrains/JetBrainsMono-Italic.ttf";
import firaRegular from "../assets/fonts/fira/FiraCode-Regular.ttf";
import firaBold from "../assets/fonts/fira/FiraCode-Bold.ttf";

interface BundledFace {
  family: string;
  url: string;
  /** 缺省 = normal。静态 ttf 各注册一份，不玩变量字体（渲染行为最可预测）。 */
  weight?: string;
  style?: string;
}

const FACES: ReadonlyArray<BundledFace> = [
  { family: "JetBrains Mono", url: jetbrainsRegular },
  { family: "JetBrains Mono", url: jetbrainsBold, weight: "700" },
  { family: "JetBrains Mono", url: jetbrainsItalic, style: "italic" },
  { family: "Fira Code", url: firaRegular },
  { family: "Fira Code", url: firaBold, weight: "700" },
];

/** 打包的 family 名单（供单测与字体栈交叉核对）。 */
export const BUNDLED_FAMILIES: ReadonlyArray<string> = ["JetBrains Mono", "Fira Code"];

const LOAD_TIMEOUT_MS = 2000;

const listeners = new Set<() => void>();
let ready = false;

export function isBundledFontsReady(): boolean {
  return ready;
}

/** 就绪广播订阅。就绪发生在订阅之前时不会再触发（调用方须自己处理这种情形）。 */
export function subscribeBundledFonts(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function finish(): void {
  if (ready) return;
  ready = true;
  listeners.forEach((l) => l());
}

function init(): void {
  // FontFace / document 缺席（jsdom、极端环境）：直接视为就绪，全部走回退链。
  if (typeof FontFace === "undefined" || typeof document === "undefined") {
    finish();
    return;
  }
  const timer = window.setTimeout(finish, LOAD_TIMEOUT_MS);
  void Promise.all(
    FACES.map(async ({ family, url, weight, style }) => {
      try {
        const face = new FontFace(family, `url(${url})`, { weight, style });
        document.fonts.add(await face.load());
      } catch {
        // 单枚失败不拖累其它；最终仍按就绪处理（该字体走回退链）。
      }
    }),
  ).then(() => {
    window.clearTimeout(timer);
    finish();
  });
}

void init();
