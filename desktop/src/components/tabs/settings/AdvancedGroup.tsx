import type { StaticStatus } from "../../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { ToggleRow } from "../../ui/ToggleRow";
import { useSettingSave } from "./useSettingSave";

/** Backend preferences follow the task category; no second source of configuration. */
export function AdvancedGroup({ status, onSaved, section = "files" }: {
  status?: StaticStatus; onSaved: () => void; section?: "network" | "files";
}) {
  const { save, isSaved, isPending, errorFor } = useSettingSave(onSaved);
  const settings = section === "network" ? [{
    key: "ratelimit", field: "rateLimitEnabled", value: status?.rateLimitEnabled ?? true,
    label: "限流保护", sub: "按窗口限制请求次数，防止异常高频调用", info: "保持限流可以防止远程工具的异常高频调用。",
  }] : [{
    key: "encoding", field: "encodingDetectEnabled", value: status?.encodingDetectEnabled ?? false,
    label: "读取编码自适应", sub: "自动识别 GBK / GB18030，适合 NC65 等旧系统源码", info: "关闭时固定按 UTF-8 读取。显式指定编码不受此设置影响。",
  }, {
    key: "session-persist", field: "sessionCwdEnabled", value: status?.sessionCwdEnabled ?? false,
    label: "命令会话持久化", sub: "使用 session_id 跨调用保留工作目录与环境变量", info: "作用于 MCP run_command，不是 SSH 会话保持。可通过 env 参数持久化 venv / PATH 等变量，默认关闭。",
  }];
  return <Card id={section === "files" ? "set-advanced" : "set-flow-protection"}>
    <CardHeader><CardTitle icon={<Icon name={section === "network" ? "shield" : "sliders"} />}>{section === "network" ? "流量保护" : "文件读取与命令行为"}</CardTitle></CardHeader>
    <CardContent>{settings.map((item, index) => <ToggleRow key={item.key} id={`toggle-${item.key}`} label={item.label} sub={item.sub} info={item.info}
      checked={item.value} onChange={value => { void save({ [item.field]: value }, item.key); }} disabled={!status}
      pending={isPending(item.key)} error={errorFor(item.key)} saved={isSaved(item.key)} last={index === settings.length - 1} />)}</CardContent>
  </Card>;
}
