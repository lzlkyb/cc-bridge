import { useState } from "react";
import { Button } from "../../../ui/button";
import { Icon } from "../../../ui/icon";
import { ConfirmModal } from "../../../ui/ConfirmModal";

/**
 * 「允许远程指定工作目录」的二次确认。
 *
 * 🔴 这是本特性里**唯一一个放宽边界**的开关，所以跟启用 server 同级确认。
 * 其它开关（默认关、逐个确认、导入不自动启用、自我排除）都在收紧，
 * 只有它把「工作目录」从管理员手里交出去一部分。
 *
 * 不复用 `EnableRiskModal`：那个的主体是「要启动的完整命令」，而这里要讲的是
 * 「远程能挑哪些目录」，两块内容几乎不重叠——强行合并会变成满屏分支。
 */
export function RemoteCwdRiskModal({
  name,
  currentCwd,
  allowedRoots,
  whitelistEnabled,
  onCancel,
  onConfirm,
}: {
  name: string;
  /** 开启前它固定在哪里。 */
  currentCwd: string;
  allowedRoots: string[];
  whitelistEnabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [ack, setAck] = useState(false);

  return (
    <ConfirmModal open onClose={onCancel} maxWidth="lg">
      <h4 className="mb-3 flex items-center gap-2 text-base font-semibold text-destructive">
        <Icon name="alertTriangle" size={18} />
        让远程自己选「{name}」的工作目录？
      </h4>

      <div className="mb-3 rounded-lg bg-muted px-3 py-2 text-xs">
        <div className="text-muted-foreground">现在它固定在：</div>
        <div className="mt-0.5 break-all font-mono text-[11.5px]">{currentCwd}</div>
      </div>

      <div className="mb-3 rounded-lg bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
        <div className="mb-1.5 font-semibold">开启后会变成：</div>
        <div className="mb-1">
          ① 远程可以每次调用指定一个目录，<b>每个目录会各起一个进程</b>。
        </div>
        <div>
          ② 白名单<b>只限它从哪里启动，不限它启动后能碰什么</b>——
          它是独立进程，起来之后照样能走出去。这是护栏，不是隔离。
        </div>
      </div>

      {whitelistEnabled ? (
        <div className="mb-3">
          <div className="mb-1 text-[11px] text-muted-foreground">
            远程只能在这 {allowedRoots.length} 个白名单根目录内挑：
          </div>
          <div className="max-h-32 overflow-y-auto rounded-lg border">
            {allowedRoots.map((r) => (
              <div key={r} className="break-all border-b px-2.5 py-1.5 font-mono text-[11px] last:border-0">
                {r}
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* 白名单关着时这道护栏根本不存在，得说清楚——
           不说的话，用户会以为自己只开了白名单那么大的口子。 */
        <div className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          ⚠ <b>路径白名单当前是关的</b>，所以远程可以指定<b>任意目录</b>。
          想要那道护栏的话，先去安全卡里把白名单开回来。
        </div>
      )}

      <label className="mb-4 flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />
        我明白这是把工作目录的选择权交给远程，且白名单拦不住它启动后的行为
      </label>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="destructive" size="sm" disabled={!ack} onClick={onConfirm}>
          允许
        </Button>
      </div>
    </ConfirmModal>
  );
}
