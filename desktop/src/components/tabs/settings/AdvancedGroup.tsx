import type { StaticStatus } from "../../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { ToggleRow } from "../../ui/ToggleRow";
import { releaseWebviewHint } from "../../../lib/platform";
import { useSettingSave } from "./useSettingSave";

/**
 * 「高级」卡：真正的“装完很少再动”项。
 *
 * 原「兼容与性能」那一节是个筐：6 项横跨 4 个领域。其中两项已归位——
 * 壳层选择 → 安全卡（它是命令执行的子项），传输协议 → 网络卡（它决定远程怎么连）。
 * 剩下这四项才是名副其实的“高级”。
 */
export function AdvancedGroup({
  status,
  onSaved,
}: {
  status?: StaticStatus;
  onSaved: () => void;
}) {
  const { savedKey, save } = useSettingSave(onSaved);
  // id 供设置页左栏导航 scrollspy 定位（lib/settingsSections.ts）。
  return (
    <Card id="set-advanced">
      <CardHeader>
        <CardTitle icon={<Icon name="sliders" />}>高级</CardTitle>
      </CardHeader>
      <CardContent className="space-y-0">
        <ToggleRow
          id="toggle-ratelimit"
          label="限流保护"
          sub="按窗口限制请求次数，防止异常高频调用"
          checked={status?.rateLimitEnabled ?? true}
          onChange={(v) => save({ rateLimitEnabled: v }, "ratelimit")}
          saved={savedKey === "ratelimit"}
        />
        <ToggleRow
          id="toggle-encoding"
          label="读取编码自适应"
          info="开启：自动识别 GBK/GB18030（适合 NC65 等旧系统源码）；关闭：固定按 UTF-8 读取，避免误判。显式指定编码不受影响"
          checked={status?.encodingDetectEnabled ?? false}
          onChange={(v) => save({ encodingDetectEnabled: v }, "encoding")}
          saved={savedKey === "encoding"}
        />
        <ToggleRow
          id="toggle-session-persist"
          label="命令会话持久化"
          info={
            <>
              开启后 run_command 可用 session_id 跨调用保留工作目录，并通过 env 参数（key=value）持久化环境变量（如 venv / PATH），解决 source venv / export 每调用丢失的问题。默认关闭
            </>
          }
          checked={status?.sessionCwdEnabled ?? false}
          onChange={(v) => save({ sessionCwdEnabled: v }, "session-persist")}
          saved={savedKey === "session-persist"}
        />
        <ToggleRow
          id="toggle-release-webview"
          label="关窗时释放界面内存"
          sub="关窗释放内存，再开需重新加载"
          info={releaseWebviewHint(status?.platform)}
          checked={status?.releaseWebviewOnClose ?? true}
          onChange={(v) => save({ releaseWebviewOnClose: v }, "release-webview")}
          saved={savedKey === "release-webview"}
        />
        <ToggleRow
          id="toggle-ssh-drag-select"
          label="终端拖拽即选"
          info="开启：在 SSH 终端内直接拖选文字即建立选区，无需按住 Shift 或点「选择模式」（远端没开鼠标追踪的会话，原生拖选本来就能用）。关闭后 Shift 与「选择模式」两条路径仍然可用"
          checked={status?.sshDragSelectEnabled ?? true}
          onChange={(v) => save({ sshDragSelectEnabled: v }, "ssh-drag-select")}
          saved={savedKey === "ssh-drag-select"}
        />
        <ToggleRow
          id="toggle-ssh-copy-on-select"
          label="选中即复制"
          info="开启：拖拽选中文字后松手即自动写入剪贴板并提示字数（双击选词、三击选行不触发）。关闭后选区照常保留，复制改走右键菜单 / 工具栏按钮 / Ctrl+Shift+C"
          checked={status?.sshCopyOnSelectEnabled ?? true}
          onChange={(v) => save({ sshCopyOnSelectEnabled: v }, "ssh-copy-on-select")}
          saved={savedKey === "ssh-copy-on-select"}
          last
        />
      </CardContent>
    </Card>
  );
}
