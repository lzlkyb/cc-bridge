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

/* ─── 设置页的平台相关文案 ──────────────────────────────────────
 *
 * 为何放在这里而不是写在组件里：
 * 1. 本文件已是「平台差异的单一判断处」，文案分叉属于同一类关注点；
 * 2. `SettingsToggles.tsx` 已经 690 行、远超项目规则的 300 行上限，不能再往里堆。
 */

/** 「命令执行壳层」一行的全部文案。 */
export interface ShellTypeCopy {
  /** 默认壳层的**显示名**（注意与存储值无关，见下方注释） */
  defaultLabel: string;
  /** 备选壳层的显示名 */
  altLabel: string;
  /** 默认壳层括号里的一句话（如「零依赖」） */
  defaultNote: string;
  /** 备选壳层的说明（接在壳层名之后） */
  altNote: string;
  /** bash 未检测到时的行内警告 */
  unavailableWarn: string;
  /** bash 未检测到时点击它的 toast */
  unavailableToast: string;
  /** 重新检测后仍未找到的 toast */
  stillUnavailableToast: string;
}

/**
 * 根据平台给出壳层选择的文案。
 *
 * ⚠ **存储值永远是 `cmd` / `bash`，不能因为文案变了就改**——后端 `ShellType`
 * 按这两个值反序列化。在 Unix 上它们的实际含义是（见 shell.rs 的
 * `build_invocation_unix`）：
 *   - `cmd`  → `/bin/sh -c`（POSIX sh，系统自带）
 *   - `bash` → 真 bash（探测 `/bin/bash` → `/usr/bin/bash` → `/usr/local/bin/bash`
 *              → `/opt/homebrew/bin/bash`）
 * 所以 mac 上把默认项**显示为 `sh`** 才准确；显示成 `cmd` 是彻底误导。
 */
export function shellTypeCopy(platform: string | undefined): ShellTypeCopy {
  if (isWindows(platform)) {
    return {
      defaultLabel: "cmd",
      altLabel: "bash",
      defaultNote: "零依赖",
      altNote: "走 Git Bash，支持 POSIX 语法 / jq / find / 管道。需本机已装 Git for Windows；切换即时生效，无需重启。",
      unavailableWarn: "⚠ 未检测到 Git for Windows，bash 暂不可用",
      unavailableToast: "未检测到 Git for Windows，bash 不可用，已保持 cmd",
      stillUnavailableToast: "仍未检测到 Git for Windows，请确认已安装",
    };
  }
  // mac / 其他 Unix。注意 mac 自带的 /bin/bash 是 3.2（GPLv2 时代的版本），
  // 想用新特性得自己装（Homebrew 的 /opt/homebrew/bin/bash 也在探测列表里）。
  return {
    defaultLabel: "sh",
    altLabel: "bash",
    defaultNote: "/bin/sh，系统自带",
    altNote: "走系统 bash，支持数组 / 进程替代等 bash 扩展语法。macOS 自带 bash 3.2，如需新版可用 Homebrew 安装；切换即时生效，无需重启。",
    unavailableWarn: "⚠ 本机未检测到 bash，暂不可用",
    unavailableToast: "本机未检测到 bash，已保持 sh",
    stillUnavailableToast: "仍未检测到 bash，请确认已安装",
  };
}

/**
 * 「关窗时释放界面内存」的说明文案。
 *
 * 两个平台的数字差得很远，而且**测量口径不同**，不能共用一句话：
 * - Windows：WebView2 是多进程（BROWSER/gpu/renderer/…），它们与主进程合计
 *   约 85MB，销毁后只剩 Rust 侧约 6MB；
 * - macOS：WKWebView 跑在独立的 `com.apple.WebKit.WebContent` 进程里，实测显示窗口后
 *   该进程约 121MB，关窗后进程直接消失；而**主进程几乎不变**（约 22MB）。
 *   所以 mac 上只看主进程会得出“webview 不要钱”的错误结论。
 */
export function releaseWebviewHint(platform: string | undefined): string {
  const saving = isMac(platform)
    ? "关窗后界面进程整体退出，释放约 120MB（主进程约 22MB 常驻）"
    : "托盘常驻内存约 85MB → 6MB";
  return `开启：关窗时销毁界面进程，${saving}，再次打开需重新加载（1~2 秒）；关闭：仅隐藏窗口，再次打开瞬时显示，但界面进程持续占用内存。MCP 服务、托盘与桌面通知均不受影响。默认开启`;
}
