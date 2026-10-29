import { createContext, useContext } from "react";
import { toolKind } from "./summarize";
export const ConversationEnvironment = createContext({ label: "", cwd: "", remote: false });
export function ApprovalEnvironment({ toolName }: { toolName: string }) {
  const env = useContext(ConversationEnvironment);
  const kind = toolKind(toolName);
  return <div className="cc-approval-environment">
    {env.label && <dl><dt>执行位置</dt><dd>{env.remote ? "SSH · " : ""}{env.label}</dd><dt>工作目录</dt><dd>{env.cwd || "默认目录（未指定）"}</dd></dl>}
    <p>{kind === "bash" ? "会执行命令；命令及脚本的全部副作用无法预先确认。" : kind === "edit" || kind === "write" ? "将修改文件，请核对以下路径及内容。" : "请核对本次工具的参数和影响范围。"}</p>
    <small>“允许一次”仅授权本次操作；“以后都放行”会保存自动放行规则。</small>
  </div>;
}
