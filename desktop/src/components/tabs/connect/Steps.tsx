import { APP_INFO } from "../../../lib/about";
import { StepNumber, CommandBlock } from "./widgets";

export function GlobalSteps({
  command,
  copied,
  onCopy,
}: {
  command: string;
  copied: boolean;
  onCopy: (command?: string) => void;
}) {
  return (
    <>
      <div className="step-row flex gap-3">
        <StepNumber n={1} />
        <div className="flex-1 space-y-1.5">
          <p className="ui-h-sub">SSH 登录远程 Linux 服务器</p>
          <p className="text-xs text-muted-foreground">在任意目录下执行即可</p>
        </div>
      </div>

      <div className="step-row flex gap-3">
        <StepNumber n={2} />
        <div className="flex-1 space-y-2">
          <p className="ui-h-sub">执行连接命令</p>
          <CommandBlock command={command} copied={copied} onCopy={onCopy} />
        </div>
      </div>

      <div className="step-row flex gap-3">
        <StepNumber n={3} done />
        <div className="flex-1 space-y-1.5">
          <p className="ui-h-sub">完成</p>
          <p className="text-xs text-muted-foreground">
            配置已写入 <code className="rounded bg-muted px-1">~/.claude.json</code>，
            之后在任何项目中启动 <code className="rounded bg-muted px-1">claude</code> 都会自动连接 {APP_INFO.name}。
          </p>
        </div>
      </div>
    </>
  );
}

export function ProjectSteps({
  command,
  copied,
  onCopy,
  projectPath,
  setProjectPath,
}: {
  command: string;
  copied: boolean;
  onCopy: (command?: string) => void;
  projectPath: string;
  setProjectPath: (v: string) => void;
}) {
  const trimmed = projectPath.trim();
  const fullCommand = trimmed
    ? `cd ${trimmed} && ${command}`
    : command;

  const handleProjectCopy = () => {
    if (!command) return;
    // H1 修复：把含 cd 前缀的完整命令交给父层统一用 copyText 复制一次，
    // 不再自行 writeText 再调 onCopy 造成双写覆盖（旧实现最终复制的是不含 cd 的命令）；
    // 同时因走 copyText 而带上了 成功/失败 反馈（修复 M4 的未 await/catch）。
    onCopy(fullCommand);
  };

  return (
    <>
      <div className="step-row flex gap-3">
        <StepNumber n={1} />
        <div className="flex-1 space-y-1.5">
          <p className="ui-h-sub">SSH 登录远程 Linux 服务器</p>
        </div>
      </div>

      <div className="step-row flex gap-3">
        <StepNumber n={2} />
        <div className="flex-1 space-y-2">
          <p className="ui-h-sub">填写远程项目路径（可选）</p>
          <p className="text-xs text-muted-foreground">
            如需进入特定目录执行，填入路径后命令前会自动加 <code className="rounded bg-muted px-1">cd</code>
          </p>
          <input
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            placeholder="/home/user/my-project"
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-xs text-muted-foreground">
            {trimmed
              ? "已自动合并为一条命令，复制即可执行"
              : "留空则需要自己先 cd 到项目目录再执行；填写后自动合并为一条命令"}
          </p>
        </div>
      </div>

      <div className="step-row flex gap-3">
        <StepNumber n={3} />
        <div className="flex-1 space-y-2">
          <p className="ui-h-sub">
            {trimmed ? "复制并执行" : "在项目目录下执行"}
          </p>
          {!trimmed && (
            <p className="text-xs text-muted-foreground">
              请确保已 <code className="rounded bg-muted px-1">cd</code> 到目标项目目录
            </p>
          )}
          <CommandBlock command={fullCommand} copied={copied} onCopy={handleProjectCopy} />
        </div>
      </div>

      <div className="step-row flex gap-3">
        <StepNumber n={4} done />
        <div className="flex-1 space-y-1.5">
          <p className="ui-h-sub">完成</p>
          <p className="text-xs text-muted-foreground">
            配置已写入项目目录的 <code className="rounded bg-muted px-1">.mcp.json</code>，
            仅在该项目中启动 <code className="rounded bg-muted px-1">claude</code> 时生效。
            如需给其他项目也添加，修改上方路径后再次复制执行即可。
          </p>
        </div>
      </div>
    </>
  );
}
