import { useEffect, useRef, type MutableRefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useTerminalFontStack, useTerminalThemeMode } from "../hooks/useTerminalAppearance";
import { useTerminalPreset } from "../hooks/useTerminalPreset";
import { FONT_SIZE_DEFAULT } from "../lib/terminalFontSize";
import { terminalThemeOptions } from "../lib/terminalTheme";
import type { SshSessionRef } from "../components/tabs/TerminalConnectionItem";
import "@xterm/xterm/css/xterm.css";

export function TerminalSample({ session, termRef }: { session: SshSessionRef; termRef: MutableRefObject<Terminal | null> }) {
  const container = useRef<HTMLDivElement>(null);
  const mode = useTerminalThemeMode();
  const preset = useTerminalPreset();
  const fontFamily = useTerminalFontStack();
  useEffect(() => {
    // A local xterm keeps the real font metrics and ANSI palette without opening a PTY or sending IPC.
    const term = new Terminal({ ...terminalThemeOptions(mode, preset), fontFamily, fontSize: FONT_SIZE_DEFAULT, cursorBlink: false, scrollback: 1000, disableStdin: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current!);
    fit.fit();
    const prompt = `\x1b[32m${session.conn.username}@${session.conn.id}\x1b[0m:\x1b[34m~/workspace/cc-bridge\x1b[0m$ `;
    term.write([
      "\x1b[90m# 设计预览 · 示例输出，未连接真实 SSH\x1b[0m", "",
      `${prompt}git status`, "On branch main", "Your branch is up to date with 'origin/main'.", "", "nothing to commit, working tree clean", "",
      `${prompt}ls`, "\x1b[34mdocs/  scripts/  src/  tests/\x1b[0m", "package.json  README.md  vite.config.ts", "",
      `${prompt}npm test`, "", "> cc-bridge@2.10.0 test", "> vitest run", "",
      " \x1b[32m✓\x1b[0m tests/connection.test.ts (8 tests)", " \x1b[32m✓\x1b[0m tests/session.test.ts (6 tests)", "",
      " Test Files  \x1b[32m2 passed\x1b[0m (2)", "      Tests  \x1b[32m14 passed\x1b[0m (14)", "   Duration  1.34s", "", prompt,
    ].join("\r\n"));
    termRef.current = term;
    const resize = new ResizeObserver(() => fit.fit());
    resize.observe(container.current!);
    return () => { resize.disconnect(); termRef.current = null; term.dispose(); };
    // Content is seeded once per demo session; theme and font changes update options below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId]);
  useEffect(() => { if (termRef.current) Object.assign(termRef.current.options, terminalThemeOptions(mode, preset), { fontFamily }); }, [mode, preset, fontFamily, termRef]);
  return <div className="review-xterm" ref={container}/>;
}
