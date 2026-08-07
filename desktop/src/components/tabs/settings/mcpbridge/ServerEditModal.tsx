import { useState } from "react";
import { Button } from "../../../ui/button";
import { Icon } from "../../../ui/icon";
import { Input } from "../../../ui/input";
import { ConfirmModal } from "../../../ui/ConfirmModal";
import type { McpBridgeServer, ServerInput } from "./types";

/**
 * 手动新增 / 编辑。
 *
 * 🔴 **编辑时拿不到现有的 env 值**（S7）：后端只传键名。所以环境变量这一栏的
 * 语义是「要么不动（留空），要么整体重填」——不能把已有的值取回来再提交一遍，
 * 那等于把密钥回显到界面。界面上把这件事说清楚，不让用户以为自己把 key 弄丢了。
 *
 * args 用**每行一个**而不是空格分隔：`--path D:\my docs` 这种带空格的参数
 * 用空格拆会静默拆错，而拆错的后果是启动参数变了一个意思。
 */
export function ServerEditModal({
  initial,
  onCancel,
  onSubmit,
}: {
  /** 为空则为新增。 */
  initial?: McpBridgeServer;
  onCancel: () => void;
  onSubmit: (input: ServerInput) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [argsText, setArgsText] = useState((initial?.args ?? []).join("\n"));
  const [cwd, setCwd] = useState(initial?.cwd ?? "");
  const [envText, setEnvText] = useState("");
  const [clearEnv, setClearEnv] = useState(false);
  const editing = !!initial;

  const nameErr =
    name && !/^[a-z0-9_-]{1,32}$/.test(name)
      ? "只允许小写字母 / 数字 / 下划线 / 连字符，最长 32"
      : null;
  const valid = !!name && !!command.trim() && !nameErr;

  const submit = () => {
    const args = argsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const lines = envText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const parsed: [string, string][] = lines.map((l) => {
      const i = l.indexOf("=");
      return i < 0
        ? ([l, ""] as [string, string])
        : ([l.slice(0, i), l.slice(i + 1)] as [string, string]);
    });
    // 空白且未勾「清空」→ 传 null（保持不变）。不能传 `[]`：
    // 前端本就拿不到现有的值，传空数组等于静默把密钥删了。
    const env = lines.length ? parsed : clearEnv ? [] : null;
    onSubmit({ name, transport: "stdio", command: command.trim(), args, env, cwd: cwd.trim() || null });
  };

  return (
    <ConfirmModal open onClose={onCancel} maxWidth="lg">
      <h4 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <Icon name={editing ? "settings" : "plus"} size={18} />
        {editing ? `编辑「${initial.name}」` : "手动添加 MCP server"}
      </h4>

      <div className="space-y-3">
        <Field label="名字" hint={nameErr ?? "远程调用时用它指定哪个 server"} error={!!nameErr}>
          <Input
            value={name}
            disabled={editing}
            onChange={(e) => setName(e.target.value)}
            placeholder="codegraph"
          />
        </Field>

        <Field label="命令" hint="可写裸名字（会查 PATH）或绝对路径">
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="codegraph"
            className="font-mono"
          />
        </Field>

        <Field label="参数" hint="每行一个。不用空格分隔——带空格的参数会被静默拆错">
          <textarea
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            rows={4}
            placeholder={"serve\n--mcp"}
            className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
          />
        </Field>

        <Field label="工作目录" hint="留空则跟随 cc-bridge 自己的工作目录">
          <Input value={cwd} onChange={(e) => setCwd(e.target.value)} className="font-mono" />
        </Field>

        <Field
          label="环境变量"
          hint={
            editing
              ? `当前已配：${initial.envKeys.length ? initial.envKeys.join("、") : "无"}。留空 = 保持不变；填了则**整体替换**。现有的值不会回显（它可能是密钥）。`
              : "每行一个 KEY=VALUE。值只进不出，保存后界面上只会看到键名。"
          }
        >
          <textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            rows={3}
            placeholder="SEMANTIC_SCHOLAR_API_KEY=..."
            className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
          />
          {/* 不给这个勾选框的话，「清空 env」就根本没有表达方式——
              留空被定义为「保持不变」了。 */}
          {editing && initial.envKeys.length > 0 && !envText.trim() && (
            <label className="mt-1.5 flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={clearEnv}
                onChange={(e) => setClearEnv(e.target.checked)}
              />
              清空现有的 {initial.envKeys.length} 个环境变量
            </label>
          )}
        </Field>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" disabled={!valid} onClick={submit}>
          下一步
        </Button>
      </div>
    </ConfirmModal>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium">{label}</div>
      {children}
      {hint && (
        <div className={`mt-1 text-[11px] ${error ? "text-destructive" : "text-muted-foreground"}`}>
          {hint}
        </div>
      )}
    </div>
  );
}
