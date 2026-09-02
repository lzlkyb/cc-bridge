/**
 * 「上次上传目录」（按连接）。
 *
 * 为什么需要它：**终端的 cwd 对我们是不可知的**。我们只是把字节流推给 xterm
 * 渲染，远端 shell 在哪个目录本地无从得知——helper 会话是另一条 shell（它的 pwd 是
 * 登录目录），OSC 7 要远端主动配合，而往终端里注入一句 `pwd` 是往一个活着的
 * shell 里打字（用户可能正在 vim 里、正在输 sudo 密码）。
 *
 * 所以不猜：把「传到哪」变成一份用户看得见、改得了、能记住的状态，
 * **文件面板与终端拖拽共用同一份**，不会出现「面板在 /opt、拖拽却传去别处」。
 */

const KEY_PREFIX = "cc-bridge.upload-dir.";

/**
 * 默认目录。
 *
 * 🔴 不能用 `~/`：后端的 `shell_quote` 会把远程路径包进**单引号**（防命令注入），
 * 而 `'~'` 在 shell 里不展开；scp 走 `-s`（SFTP 协议）时路径按字面处理，同样不展开。
 * 填 `~/` 的后果是在远端造出一个叫 `~` 的目录，或者直接报路径不存在。
 * 所以默认沿用 `/`（与文件面板原来的起始路径一致），第一次由用户选定，之后记住。
 */
export const DEFAULT_UPLOAD_DIR = "/";

/** 归一化远程目录：去首尾空白、折叠重复斜杠、去末尾斜杠（根目录除外）。 */
export function normalizeRemoteDir(raw: string): string {
  const t = raw.trim();
  if (!t) return DEFAULT_UPLOAD_DIR;
  const collapsed = t.replace(/\/{2,}/g, "/");
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/, "") || "/";
}

/**
 * 校验目标目录，返回错误文案（null = 合法）。
 *
 * 在提交前拦下来，而不是让 scp 报一句看不懂的错——尤其是 `~`：
 * 它看起来完全合理，但在引号里不会展开，失败方式很难看懂。
 */
export function remoteDirError(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "请填写目标目录";
  if (t.startsWith("~")) {
    return "远端不会展开 ~，请填绝对路径（如 /home/你的用户名）";
  }
  if (!t.startsWith("/")) return "请填绝对路径，以 / 开头";
  return null;
}

/** 拼接远程目录与文件名。 */
export function joinRemoteDir(dir: string, name: string): string {
  const d = normalizeRemoteDir(dir);
  return d === "/" ? `/${name}` : `${d}/${name}`;
}

export function loadUploadDir(connectionId: string): string {
  try {
    const v = localStorage.getItem(KEY_PREFIX + connectionId);
    return v ? normalizeRemoteDir(v) : DEFAULT_UPLOAD_DIR;
  } catch {
    // 隐私模式 / 存储被禁用：降级成默认值，不要因为记不住目录就让上传用不了。
    return DEFAULT_UPLOAD_DIR;
  }
}

export function saveUploadDir(connectionId: string, dir: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + connectionId, normalizeRemoteDir(dir));
  } catch {
    /* 同上：记不住不影响本次上传 */
  }
}

/** 人读的字节数（确认条上展示总体量）。 */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
