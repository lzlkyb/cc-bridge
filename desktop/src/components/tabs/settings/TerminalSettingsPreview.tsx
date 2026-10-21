import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Icon } from "../../ui/icon";
import { useTerminalFontStack, useTerminalThemeMode } from "../../../hooks/useTerminalAppearance";
import { useTerminalPreset } from "../../../hooks/useTerminalPreset";
import { loadFontSize, subscribeFontSize } from "../../../lib/terminalFontSize";
import { terminalThemeOptions } from "../../../lib/terminalTheme";
import { isBundledFontsReady, subscribeBundledFonts } from "../../../lib/bundledFonts";
import { useViewActive } from "../../../lib/viewActivity";
import "@xterm/xterm/css/xterm.css";

const SAMPLE = "\x1b[36m~/projects/cc-bridge\x1b[0m  \x1b[35mmain\x1b[0m\r\n\x1b[32m❯\x1b[0m npm run dev\r\n\r\n\x1b[32m  VITE\x1b[0m  ready in 186 ms\r\n\r\n  服务已启动，等待连接\r\n  Ag 0O 1lI  0123456789\r\n\r\n\x1b[32m❯\x1b[0m ";

/** Read-only local xterm: no connection, input handler, polling or remote command. */
export function TerminalSettingsPreview() {
  const mode = useTerminalThemeMode();
  const preset = useTerminalPreset();
  const fontFamily = useTerminalFontStack();
  const [fontSize, setFontSize] = useState(loadFontSize);
  const [expanded, setExpanded] = useState(false);
  const active = useViewActive();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const options = useRef({ ...terminalThemeOptions(mode, preset), fontFamily, fontSize });
  options.current = { ...terminalThemeOptions(mode, preset), fontFamily, fontSize };
  useEffect(() => subscribeFontSize(setFontSize), []);

  useEffect(() => {
    if (!active || !host.current) return;
    const element = host.current;
    let disposed = false;
    const render = () => {
      // Hidden categories/compact previews should not allocate a terminal until shown.
      if (disposed || !isBundledFontsReady() || element.clientWidth === 0 || element.clientHeight === 0) return;
      if (!term.current) {
        const terminal = new Terminal({ ...options.current, cursorBlink: false, disableStdin: true, lineHeight: 1.4, scrollback: 0 });
        const addon = new FitAddon(); terminal.loadAddon(addon); terminal.open(element);
        if (terminal.textarea) terminal.textarea.tabIndex = -1;
        terminal.write(SAMPLE);
        term.current = terminal; fit.current = addon;
      }
      fit.current?.fit();
    };
    const observer = new ResizeObserver(render); observer.observe(element);
    const unsubscribeFonts = subscribeBundledFonts(render);
    render();
    return () => {
      disposed = true; observer.disconnect(); unsubscribeFonts();
      term.current?.dispose(); term.current = null; fit.current = null;
    };
  }, [active]);

  useEffect(() => {
    if (!term.current) return;
    Object.assign(term.current.options, options.current);
    if (host.current?.clientWidth && host.current.clientHeight) fit.current?.fit();
  }, [mode, preset, fontFamily, fontSize]);

  return <aside className="terminal-settings-preview" data-expanded={expanded || undefined} aria-label="终端外观预览">
    <div className="terminal-preview-heading"><h2>终端预览</h2><span>实时</span><button type="button" className="terminal-preview-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "展开"}</button></div>
    <div className="terminal-preview-window">
      <div className="terminal-preview-caption"><Icon name="terminal" size={14} />预览会话<span>只读示例</span></div>
      <div role="img" aria-label="示例终端：路径、Git 分支、英文命令、中文日志与易混淆字符。不会连接 SSH 或执行命令。"
        className="terminal-preview-canvas" ref={host} style={{ background: terminalThemeOptions(mode, preset).theme.background }} />
      <div className="terminal-preview-caption"><Icon name="gitBranch" size={12} />main<span>UTF-8</span></div>
    </div>
    <p className="terminal-preview-help">直接比较配色、字体与中文显示。示例不会连接 SSH 或执行命令。</p>
    <p className="terminal-preview-help terminal-preview-advice"><Icon name="info" size={14} />正在运行的全屏程序可能需重新启动，才能识别终端明暗变化。</p>
  </aside>;
}
