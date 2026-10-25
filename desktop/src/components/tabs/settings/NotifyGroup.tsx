import { useState } from "react";
import type { StaticStatus } from "../../../lib/types";
import { invoke } from "../../../lib/tauri";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { ToggleRow } from "../../ui/ToggleRow";
import { SettingsRow } from "../../ui/SettingsRow";
import { Button } from "../../ui/button";
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
  const { isSaved, isPending, errorFor, save } = useSettingSave(onSaved);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const testNotification = async () => {
    if (testing) return;
    setTesting(true); setTestResult("");
    try {
      const sent = await invoke<boolean>("notify_desktop", { title: "CC Bridge · 测试通知", body: "通知通道已提交测试提醒。" });
      setTestResult(sent ? "已向系统提交通知；若未显示，请检查系统通知权限或勿扰模式。" : "未发送通知。请检查任务通知开关、系统通知权限及当前安装版本是否支持通知。");
    } catch (e) { setTestResult(`通知测试失败：${e}。请稍后重试。`); }
    finally { setTesting(false); }
  };
  // id 供设置页左栏导航 scrollspy 定位（lib/settingsSections.ts）。
  return (
    <Card id="set-notify">
      <CardHeader>
        <CardTitle icon={<Icon name="bell" />}>完成提醒</CardTitle>
      </CardHeader>
      <CardContent className="space-y-0">
        <ToggleRow
          id="toggle-notify-command"
          label="后台命令完成通知"
          sub="命令结束后弹系统通知"
          info={notifyCommandCompleteSub(status?.platform)}
          checked={status?.notifyCommandComplete ?? true}
          onChange={(v) => save({ notifyCommandComplete: v }, "notify-cmd")}
          saved={isSaved("notify-cmd")} pending={isPending("notify-cmd")} error={errorFor("notify-cmd")} disabled={!status}
        />
        <ToggleRow
          id="toggle-notify-task"
          label="任务完成通知"
          sub="关闭后 AI 的推送请求会被静默忽略"
          info="AI 完成任务后可主动调用 push_notification 工具推送桌面通知。关闭后 AI 的推送请求会被静默忽略。默认开启"
          checked={status?.notifyTaskComplete ?? true}
          onChange={(v) => save({ notifyTaskComplete: v }, "notify-task")}
          saved={isSaved("notify-task")} pending={isPending("notify-task")} error={errorFor("notify-task")} disabled={!status}
        />
        <ToggleRow
          id="toggle-notify-cc"
          label="CC 对话完成通知"
          sub="一轮对话结束后弹系统通知"
          info="只对对话页发起的一轮生效：长任务跑到一半切去别的窗口，完成了这边会提醒你。「任务完成通知」是总开关，关着时本项也不会推送。默认关闭"
          checked={status?.ccNotifyTurnEnd ?? false}
          onChange={(v) => save({ ccNotifyTurnEnd: v }, "notify-cc")}
          saved={isSaved("notify-cc")} pending={isPending("notify-cc")} error={errorFor("notify-cc")} disabled={!status}
        />
        <SettingsRow label="测试系统通知" sub={status?.notifyTaskComplete === false ? "任务完成通知已关闭，启用后可测试。" : "仅在点击时发送，用于检查通知是否可用。"} last control={<Button variant="outline" size="sm" disabled={!status || !status.notifyTaskComplete || isPending("notify-task")} isLoading={testing} loadingText="发送中…" onClick={() => { void testNotification(); }}>发送测试通知</Button>} />
        {testResult && <p role="status" className="text-xs leading-relaxed text-muted-foreground">{testResult}</p>}
      </CardContent>
    </Card>
  );
}
