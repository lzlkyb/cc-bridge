// 应用元信息（关于卡片用）。数据来源（均为真实，未编造）：
// - 仓库地址：src-tauri/tauri.conf.json 的 updater.endpoints
// - 作者：GitHub 用户 lzlkyb（Cargo.toml 无 authors 字段）
// - 协议：根目录 LICENSE（MIT）
// - 更新历史：由 scripts/gen-changelog.mjs 在 predev/prebuild 时从根目录 CHANGELOG.md
//   （Keep a Changelog，唯一手写源）自动解析生成 lib/changelog.generated.ts，此处 re-export。
//   分类映射（新增→feat / 变更→improve / 修复→fix / 安全→sec，技术依赖测试说明→improve）
//   集中在脚本内，根除此前手写 about.ts 数组「双份维护、漏写版本」的痛点。

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
  /** 本期亮点（可选）：CHANGELOG.md 的 `### 亮点` 小节，UI 顶部渐变条突出展示。 */
  highlights?: string[];
}

// CHANGELOG 现由脚本从 CHANGELOG.md 自动生成（见 scripts/gen-changelog.mjs），
// 此处仅 re-export，避免手写数组与 CHANGELOG.md 双份维护、漏写版本。
export { CHANGELOG } from "./changelog.generated";
