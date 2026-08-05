import type { StaticStatus } from "../../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { ToggleRow } from "../../ui/ToggleRow";
import { notifyCommandCompleteSub } from "../../../lib/platform";
import { useSettingSave } from "./useSettingSave";

/**
 * 「通知」卡。从原「功能开关」拆出，内容未变。
 */
export function NotifyGroup({
  status,
  onSaved,
}: {
  status?: StaticStatus;
  onSaved: () => void;
}) {
  const { savedKey, save } = useSettingSave(onSaved);
  return (
    <Card>
      <CardHeader>
        <CardTitle icon={<Icon name="activity" />}>通知</CardTitle>
      </CardHeader>
      <CardContent className="space-y-0">
        <ToggleRow
          id="toggle-notify-command"
          label="后台命令完成通知"
          sub={notifyCommandCompleteSub(status?.platform)}
          checked={status?.notifyCommandComplete ?? true}
          onChange={(v) => save({ notifyCommandComplete: v }, "notify-cmd")}
          saved={savedKey === "notify-cmd"}
        />
        <ToggleRow
          id="toggle-notify-task"
          label="任务完成通知"
          sub="AI 完成任务后可主动调用 push_notification 工具推送桌面通知。关闭后 AI 的推送请求会被静默忽略。默认开启"
          checked={status?.notifyTaskComplete ?? true}
          onChange={(v) => save({ notifyTaskComplete: v }, "notify-task")}
          saved={savedKey === "notify-task"}
          last
        />
      </CardContent>
    </Card>
  );
}
