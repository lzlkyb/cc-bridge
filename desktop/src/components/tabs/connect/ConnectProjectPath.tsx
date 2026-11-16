import { useId } from "react";

export function ConnectProjectPath({ path, onChange, automatic, disabled }: {
  path: string; onChange: (path: string) => void; automatic?: boolean; disabled?: boolean;
}) {
  const id = useId();
  return <div className="connect-path">
    <label htmlFor={id}>远程项目路径 <span>{automatic ? "一键接入时必填" : "可选"}</span></label>
    <input id={id} aria-describedby={`${id}-hint`} disabled={disabled} value={path} onChange={e => onChange(e.target.value)} placeholder="/home/user/my-project" />
    <p id={`${id}-hint`}>{automatic ? "配置将写入此服务器项目。" : path.trim() ? "已将路径合并到下方命令，复制后可直接执行。" : "留空时，请先在远程终端 cd 到项目目录。"}</p>
  </div>;
}
