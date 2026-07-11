// 应用元信息（关于卡片用）。数据来源（均为真实，未编造）：
// - 仓库地址：src-tauri/tauri.conf.json 的 updater.endpoints
// - 作者：GitHub 用户 lzlkyb（Cargo.toml 无 authors 字段）
// - 协议：根目录 LICENSE（MIT）
// - 更新历史：根目录 CHANGELOG.md（Keep a Changelog），此处精炼为条目列表。
// 注：CHANGELOG.md 最新仅到 2.2.17，2.2.18–2.2.21 尚未补录，待维护。

export const APP_INFO = {
  name: "CC Bridge",
  author: "lzlkyb",
  repoUrl: "https://github.com/lzlkyb/cc-bridge",
  license: "MIT",
  description: "本地 MCP 桥接桌面工具",
} as const;

export type ChangeCategory = "feat" | "improve" | "fix" | "sec";

export const CATEGORY_LABELS: Record<ChangeCategory, string> = {
  feat: "新增",
  improve: "改进",
  fix: "修复",
  sec: "安全",
};

export interface ChangelogItem {
  category: ChangeCategory;
  text: string;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  items: ChangelogItem[];
}

// 取自根目录 CHANGELOG.md（2.2.13–2.2.17 真实记录，精炼为条目列表，未编造）。
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "2.2.17",
    date: "07-10",
    items: [
      { category: "feat", text: "notebook_edit MCP 工具，支持编辑 .ipynb 文件" },
      { category: "feat", text: "search_files 富 Grep 选项（上下文 / 行号 / 输出模式）" },
      { category: "improve", text: "run_command 新增 description 字段，便于审计区分" },
    ],
  },
  {
    version: "2.2.16",
    date: "07-10",
    items: [
      { category: "improve", text: "进程树治理迁移到 process-wrap，消除竞态" },
      { category: "improve", text: "显式 start_kill() 杀整树，杜绝孙进程泄漏" },
    ],
  },
  {
    version: "2.2.15",
    date: "07-10",
    items: [
      { category: "sec", text: "run_command 危险命令拦截（rm -rf /、fork bomb）" },
      { category: "sec", text: "启发式子串黑名单兜底" },
    ],
  },
  {
    version: "2.2.14",
    date: "07-10",
    items: [
      { category: "fix", text: "根治子进程 stdout/stderr 读不到内容" },
      { category: "fix", text: "改用 CREATE_NO_WINDOW + Stdio::piped spawn" },
    ],
  },
  {
    version: "2.2.13",
    date: "07-10",
    items: [
      { category: "improve", text: "Job Object 替换 taskkill，进程管控更可靠" },
      { category: "improve", text: "ignore + globset，完整 glob 语义" },
      { category: "feat", text: "edit_files / write_files 新增 diff 字段" },
    ],
  },
];
