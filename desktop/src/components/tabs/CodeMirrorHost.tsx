import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import type { Theme } from "../../lib/theme";

interface Props {
  value: string;
  onChange?: (value: string) => void;
  /** 只读（大文件预览 / 冲突未决时）。 */
  readOnly?: boolean;
  /** 语言扩展（`remoteFileLang.languageFor`）。 */
  extensions?: Extension[];
  theme: Theme;
  className?: string;
  /** 保存快捷键由父层提供（Ctrl+S / ⌘S）。 */
  onSave?: () => void;
}

/**
 * CodeMirror 6 的最小 React 绑定。
 *
 * 为什么不引 `@uiw/react-codemirror`：它自带一套主题与包体积，且本项目主题走
 * Tailwind CSS 变量。这里 60 行手写绑定反而更可控——扩展、只读、快捷键都是
 * 显式的，主题跟着 `useThemeMode()` 走，亮暗切换不需要重建编辑器（reconfigure）。
 *
 * 关键点：`value` 变化只在**外部**写入时同步进编辑器（用 `EditorState.toJSON`
 * 不需要——直接比 `view.state.doc.toString()`），避免和用户正在敲的输入互相覆盖。
 */
export function CodeMirrorHost({
  value,
  onChange,
  readOnly,
  extensions,
  theme,
  className,
  onSave,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 用 ref 存回调：onChange/onSave 每次渲染都是新函数，写进 extensions 会重建编辑器。
  const cbRef = useRef({ onChange, onSave });
  cbRef.current = { onChange, onSave };
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          cbRef.current.onSave?.();
          return true;
        },
      },
    ]);
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          ...(extensions ?? []),
          lineNumbers(),
          foldGutter({ openText: "▾", closedText: "▸" }),
          history(),
          bracketMatching(),
          indentOnInput(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          saveKeymap,
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorState.readOnly.of(!!readOnlyRef.current),
          EditorView.editable.of(!readOnlyRef.current),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbRef.current.onChange?.(u.state.doc.toString());
          }),
          editorTheme(theme),
          EditorView.lineWrapping,
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // value 故意不在依赖里：它由 updateListener 单向流出，进来只在下面那个 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions, theme]);

  // 外部写入同步（首次加载、重新加载、撤销冲突后回退）。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  return <div ref={hostRef} className={className} data-testid="cm-host" />;
}

/**
 * 编辑器主题：跟随应用亮暗，颜色取自 Tailwind 的 CSS 变量，和终端/面板一致。
 * 只覆盖 CodeMirror 自己那几层（gutters / content / cursor / selection），
 * 语法高亮色仍用 `defaultHighlightStyle`（亮色）——深色下对比度略弱但可读，
 * 不值得为此引入整套 one-dark 主题包。
 */
function editorTheme(theme: Theme): Extension {
  const dark = theme === "dark";
  return EditorView.theme(
    {
      "&": {
        color: "hsl(var(--foreground))",
        backgroundColor: "hsl(var(--card))",
        fontSize: "12.5px",
        height: "100%",
      },
      ".cm-scroller": {
        fontFamily:
          "ui-monospace, SFMono-Regular, 'Cascadia Mono', Menlo, Consolas, 'Liberation Mono', monospace",
        lineHeight: "1.55",
      },
      ".cm-content": { caretColor: "hsl(var(--primary))", padding: "6px 0" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "hsl(var(--primary))" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: dark ? "hsl(var(--primary) / 26%)" : "hsl(var(--primary) / 18%)" },
      ".cm-gutters": {
        backgroundColor: "hsl(var(--card))",
        color: "hsl(var(--muted-foreground))",
        border: "none",
        borderRight: "1px solid hsl(var(--border))",
      },
      ".cm-activeLine": { backgroundColor: dark ? "rgba(255,255,255,0.035)" : "rgba(15,23,42,0.035)" },
      ".cm-activeLineGutter": {
        backgroundColor: dark ? "rgba(255,255,255,0.05)" : "rgba(15,23,42,0.05)",
        color: "hsl(var(--foreground))",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "hsl(var(--muted) / 60%)",
        border: "1px solid hsl(var(--border))",
        color: "hsl(var(--muted-foreground))",
      },
    },
    { dark },
  );
}
