import { useState, useRef, type KeyboardEvent, type ClipboardEvent } from "react";

/** 分类定义 */
const CATEGORIES = [
  {
    key: "front",
    label: "前端",
    dot: "#4F46E5",
    chipClass: "c-front",
    tagClass: "tag-front",
    btnClass: "cat-front",
    exts: [".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".html", ".json", ".vue", ".svelte"],
  },
  {
    key: "back",
    label: "后端",
    dot: "#D55B0C",
    chipClass: "c-back",
    tagClass: "tag-back",
    btnClass: "cat-back",
    exts: [".py", ".go", ".rs", ".java", ".rb", ".php", ".c", ".cpp", ".kt", ".swift"],
  },
  {
    key: "conf",
    label: "配置",
    dot: "#078051",
    chipClass: "c-conf",
    tagClass: "tag-conf",
    btnClass: "cat-conf",
    exts: [".yaml", ".yml", ".toml", ".ini", ".env", ".conf"],
  },
  {
    key: "doc",
    label: "文档",
    dot: "#07889B",
    chipClass: "c-doc",
    tagClass: "tag-doc",
    btnClass: "cat-doc",
    exts: [".md", ".txt", ".csv", ".log", ".rst", ".tex"],
  },
];

/**
 * 芯片输入组件 — 扩展名选择器。
 * 支持：分类按钮展开勾选 / 自定义输入 / 回车逗号分隔 / 粘贴拆分 / Backspace 删除。
 */
export function ChipInput({
  value,
  onChange,
  placeholder = "输入扩展名，回车添加",
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (ext: string) => {
    const e = ext.trim().replace(/^\.?/, ".");
    if (!e || e.length < 2 || value.includes(e)) return;
    onChange([...value, e]);
  };

  const remove = (ext: string) => {
    onChange(value.filter((v) => v !== ext));
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      e.preventDefault();
      input
        .split(/[,;]/)
        .filter(Boolean)
        .forEach((v) => add(v));
      setInput("");
    }
    if (e.key === "Backspace" && input === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    text
      .split(/[,;\s]+/)
      .filter(Boolean)
      .forEach((v) => add(v));
    setInput("");
  };

  const toggleCat = (catKey: string) => {
    setOpenCat((prev) => (prev === catKey ? null : catKey));
  };

  const toggleExt = (ext: string) => {
    if (value.includes(ext)) remove(ext);
    else add(ext);
  };

  const getCatForExt = (ext: string): string | undefined => {
    for (const cat of CATEGORIES) {
      if (cat.exts.includes(ext)) return cat.key;
    }
    return undefined;
  };

  return (
    <div>
      {/* 已选芯片 */}
      <div className="chip-bar flex min-h-[40px] flex-wrap items-center gap-[5px] rounded-lg border border-border bg-card px-2.5 py-[7px]">
        {value.length === 0 && (
          <span className="text-xs text-muted-foreground opacity-60">未选择扩展名</span>
        )}
        {value.map((ext) => {
          const catKey = getCatForExt(ext);
          const cls = catKey ? `c-${catKey}` : "";
          return (
            <span key={ext} className={`chip inline-flex items-center gap-1 rounded-md px-2 py-[3px] font-mono text-[11.5px] font-semibold tracking-wide ${cls}`}>
              {ext}
              <button
                type="button"
                className="chip-x ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full border-0 text-[11px] leading-none opacity-50 transition-all"
                onClick={() => remove(ext)}
              >
                &times;
              </button>
            </span>
          );
        })}
      </div>

      {/* 分类按钮 */}
      <div className="mt-2 flex flex-wrap items-start gap-1.5">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            type="button"
            className={`cat-btn inline-flex items-center gap-1.5 rounded-lg border-1.5 border-border bg-card px-3 py-1.5 text-xs font-semibold tracking-wide text-muted-foreground transition-all hover:bg-muted hover:text-foreground ${cat.btnClass} ${openCat === cat.key ? "open" : ""}`}
            onClick={() => toggleCat(cat.key)}
          >
            <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: cat.dot }} />
            {cat.label}
            <span className="text-[10px] font-bold opacity-80">
              {value.filter((v) => cat.exts.includes(v)).length}
            </span>
            <svg className="chevron h-2.5 w-2.5 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        ))}
      </div>

      {/* 展开面板 */}
      {CATEGORIES.map((cat) =>
        openCat === cat.key ? (
          <div key={cat.key} className="mt-1 flex flex-wrap gap-1">
            {cat.exts.map((ext) => {
              const sel = value.includes(ext);
              return (
                <button
                  key={ext}
                  type="button"
                  className={`ext-tag inline-flex items-center gap-1 rounded-md border-1.5 border-transparent bg-muted px-2 py-[3px] font-mono text-[11px] font-medium tracking-wide text-muted-foreground transition-all hover:border-border hover:text-foreground ${cat.tagClass} ${sel ? "checked" : ""}`}
                  onClick={() => toggleExt(ext)}
                >
                  {sel ? "✓ " : ""}{ext}
                </button>
              );
            })}
          </div>
        ) : null,
      )}

      {/* 自定义输入 */}
      <div className="mt-2 flex items-center gap-2">
        <span className="shrink-0 text-[11px] font-medium text-foreground">自定义</span>
        <input
          ref={inputRef}
          className="h-[34px] min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 font-mono text-xs text-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          onPaste={handlePaste}
        />
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground transition-all hover:border-primary hover:bg-muted hover:text-foreground"
          onClick={() => {
            input
              .split(/[,;\s]+/)
              .filter(Boolean)
              .forEach((v) => add(v));
            setInput("");
          }}
        >
          添加
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-0.5 text-[11px] font-semibold tracking-wide text-destructive transition-all hover:border-destructive"
          onClick={() => onChange([])}
        >
          清空
        </button>
      </div>
    </div>
  );
}
