import { useState } from "react";
import { Button } from "../../../ui/button";
import { Icon } from "../../../ui/icon";
import { ConfirmModal } from "../../../ui/ConfirmModal";
import { fullCommand } from "./types";

/**
 * 启用 / 新增 / 改参数的二次确认。**三者共用同一个弹窗**（S1）。
 *
 * 为何改参数也要同级确认：它与启用在实效上是一回事——把 `D:\proj` 改成 `D:`
 * 不需要重新启用就生效了。
 *
 * 布局上命令行在风险文案**之上**：先看到具体要启动什么，风险才能落到实处；
 * 反过来就变成一段泛泛的免责声明。
 */
export function EnableRiskModal({
  name,
  command,
  args,
  envKeys,
  effectiveCwd,
  mode,
  onCancel,
  onConfirm,
}: {
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  /** `cwd` 为空时实际生效的目录；自定义了就直接传那个。 */
  effectiveCwd?: string | null;
  mode: "enable" | "save";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [ack, setAck] = useState(false);
  const title = mode === "enable" ? `启用「${name}」？` : `保存「${name}」的启动参数？`;

  return (
    <ConfirmModal open onClose={onCancel}>
      <h4 className="mb-3 flex items-center gap-2 text-base font-semibold text-destructive">
        <Icon name="alertTriangle" size={18} />
        {title}
      </h4>

      <p className="mb-1.5 text-xs text-muted-foreground">将以本机当前用户身份启动：</p>
      {/* 🔴 逐字展示，不高亮任何片段（S0/S5）。很想把看着像路径的参数标红，
          但那就是在猜「哪个参数是路径」；猜错一次就会让用户以为「没标红的就是安全的」。 */}
      <div className="mb-2 break-all rounded-lg bg-muted px-3 py-2 font-mono text-[11.5px] leading-relaxed">
        {fullCommand(command, args)}
      </div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>工作目录：{effectiveCwd || "跟随 cc-bridge"}</span>
        <span>环境变量：{envKeys.length ? envKeys.join("、") : "无"}</span>
      </div>

      <div className="mb-3 rounded-lg bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
        <div className="mb-1.5 font-semibold">启用后会发生什么：</div>
        <div className="mb-1">① 远程 Claude Code 将获得这个 server 的<b>全部能力</b>。</div>
        <div className="mb-1">
          ② cc-bridge 的路径白名单<b>管不着它</b>——它是独立进程，能碰到什么由上面那行参数决定。
        </div>
        <div>③ 审计只能记下转发了什么；它进程内部读写了哪些文件，cc-bridge <b>看不见</b>。</div>
      </div>

      <label className="mb-4 flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />
        我已逐字确认上面的命令与参数，包括它可能包含的目录范围
      </label>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="destructive" size="sm" disabled={!ack} onClick={onConfirm}>
          {mode === "enable" ? "启用" : "保存"}
        </Button>
      </div>
    </ConfirmModal>
  );
}
