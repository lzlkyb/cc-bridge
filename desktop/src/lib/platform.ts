/**
 * 平台差异的单一判断处。
 *
 * 平台值来自后端 `get_status` 的 `platform` 字段（Rust `std::env::consts::OS`，
 * 编译期常量）——比嗅探 `navigator.userAgent` 可靠，也不需要引入
 * `@tauri-apps/plugin-os` 依赖。
 *
 * 为何全部参数都是 `string | undefined`：`status` 在首帧（首次 get_status 返回前）
 * 为 undefined。此时的取舍是**宁可当成非 mac**：
 * - `isWindows(undefined)` 返回 false → Windows 专属 UI 首帧不闪现（拿到状态后再出现）；
 * - `isMac(undefined)` 返回 false → 快捷键标签首帧先显示 Ctrl，mac 上拿到状态后变 ⌘。
 * 两者都是“错一帧但不会误展示不可用功能”的方向。
 */

/** 是否 Windows。Windows 专属 UI（防火墙卡片/告警）用它门控。 */
export function isWindows(platform: string | undefined): boolean {
  return platform === "windows";
}

/** 是否 macOS。 */
export function isMac(platform: string | undefined): boolean {
  return platform === "macos";
}

/**
 * 修饰键的**显示标签**：mac 用 `⌘`，其余用 `Ctrl`。
 *
 * 注意：这只影响文案。**快捷键功能本身早已兼容 mac**——键盘监听用的是
 * `e.ctrlKey || e.metaKey`（见 App.tsx），所以 mac 上按 ⌘ 本来就能触发，
 * 只是提示文字一直写着 Ctrl。
 */
export function modKeyLabel(platform: string | undefined): string {
  return isMac(platform) ? "⌘" : "Ctrl";
}

/**
 * 拼快捷键标签，如 `Ctrl+K` / `⌘K`。
 * mac 惯例不写加号（`⌘K` 而非 `⌘+K`），这里跟随惯例。
 */
export function shortcutLabel(platform: string | undefined, key: string): string {
  return isMac(platform) ? `⌘${key}` : `Ctrl+${key}`;
}
