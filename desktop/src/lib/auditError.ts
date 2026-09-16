/**
 * 审计 / 备份类文件操作的错误翻译。
 *
 * 后端抛上来的是英文 OS 错误串，原样丢进红框用户读不出「备份没了 / 文件被占用 /
 * 没权限」——只能看到 `os error 32` 这种码。这里翻成人话，**原始串保留在末尾**，
 * 排查时不丢信息。
 *
 * 为何独立成模块、且刻意避开 `friendlyError` 这个名字：
 * `contexts/UpdateContext.tsx` 已导出 `friendlyError(raw): FriendlyError`
 * （更新流程专用，返回 `{ friendly, raw }`）。同名但签名与返回类型都不同，
 * 后来者 `import { friendlyError }` 拿到什么完全取决于从哪个模块导入。改名 + 独立
 * 模块把这个歧义消掉；顺手也让 LogDetailPanel 少 19 行（它已超 300 行红线）。
 */
export function friendlyAuditError(e: unknown): string {
  const raw = String(e);
  const low = raw.toLowerCase();
  if (low.includes("not found") || raw.includes("不存在"))
    return `备份文件不存在或已被清理，无法继续操作。（${raw}）`;
  if (low.includes("os error 32") || low.includes("busy") || low.includes("being used"))
    return `目标文件正被其它程序占用，请关闭占用它的程序后重试。（${raw}）`;
  if (low.includes("os error 5") || low.includes("permission") || low.includes("denied"))
    return `没有读写权限——文件可能为只读，或需要管理员权限。（${raw}）`;
  if (low.includes("os error 2"))
    return `文件或目录不存在，可能已被移动或删除。（${raw}）`;
  return `操作失败：${raw}`;
}
