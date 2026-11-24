import { useEffect, useState } from "react";

interface Props {
  /** 列目录进行中（慢提示只在此期间可能出现）。 */
  loading: boolean;
  /** 该连接当前已断开。 */
  disconnected?: boolean;
  onReconnect?: () => void;
}

/** 列目录超过这个时长还没回来，就在界面上解释一下（而不是让圈一直转）。 */
const SLOW_HINT_MS = 2500;

/**
 * 文件面板的两条常驻提示：慢加载解释 + 断线横幅。
 *
 * 从 `SshFileBrowser` 下沉（体量棘轮）：两条都是「与列表平行的信息带」，
 * 各自带一个计时器状态，留在大组件里会把它同时背着导航 / 传输 / 瞬时操作 /
 * 编辑器四套生命周期之外再添一套。
 *
 * WHY 慢提示必须存在：本机 OpenSSH 不支持连接复用（无 ControlMaster），
 * 每次列目录都是一次完整的 TCP + 认证握手，慢链路上好几秒很正常；
 * 只转圈不说话，用户无法区分「慢」和「死」。
 * WHY 断线横幅必须存在：面板是覆盖层，用户看不到下面终端里的黄色横幅与
 * 「重新连接」，以前只能一路点到返回再去找终端。
 */
export function SshFileNotices({ loading, disconnected, onReconnect }: Props) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), SLOW_HINT_MS);
    return () => clearTimeout(t);
  }, [loading]);

  return (
    <>
      {loading && slow && (
        <div className="shrink-0 border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          正在读取远程目录…首次需要建立一条常驻会话，后续操作会快很多；若服务器不支持常驻会话会自动退回旧方式，最长可能等一分钟。
        </div>
      )}

      {disconnected && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          <span className="min-w-0 flex-1">这条连接已断开，列表是断开前的快照，文件操作会失败。</span>
          {onReconnect && (
            <button
              type="button"
              onClick={onReconnect}
              className="shrink-0 rounded-md bg-amber-500/20 px-2 py-1 font-medium hover:bg-amber-500/30"
            >
              重新连接
            </button>
          )}
        </div>
      )}
    </>
  );
}
