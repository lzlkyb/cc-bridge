import { useEffect, useMemo, useState } from "react";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Icon } from "../ui/icon";
import { Combobox, type ComboboxOption } from "../ui/combobox";
import { SshAuthFields, Field } from "./SshAuthFields";
import type { SshConnection } from "../../lib/types";

interface Props {
  open: boolean;
  initial: SshConnection | null;
  /** 已有的全部连接：跳板机就从这里选。 */
  connections: SshConnection[];
  onClose: () => void;
  onSaved: () => void;
}

/** 下拉里代表「不用跳板机」的值。后端存的是空字符串，两者在提交时映射。 */
const NO_JUMP = "";

const empty = (): SshConnection => ({
  id: "",
  name: "",
  host: "",
  port: 22,
  username: "",
  authType: "password",
  rememberPassword: false,
  encryptedPassword: "",
  keyPath: "",
  rememberPassphrase: false,
  encryptedPassphrase: "",
  proxyJumpId: "",
});

/**
 * 新建 / 编辑 SSH 连接弹框。
 * 密码仅「记住密码」时随 save 一并发往后端加密落盘；不记住时忽略，明文不出本弹框。
 */
export function SshConnectionDialog({ open, initial, connections, onClose, onSaved }: Props) {
  const [form, setForm] = useState<SshConnection>(empty());
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(initial ? { ...initial } : empty());
      setPassword("");
      setPassphrase("");
    }
  }, [open, initial]);

  const set = <K extends keyof SshConnection>(k: K, v: SshConnection[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // 跳板机候选。不可选的不隐藏而是置灰并给理由：列表里凭空少一条连接，
  // 用户无从知道是自己看错了还是它本来就不能选。
  const jumpOptions = useMemo<ComboboxOption[]>(() => {
    const opts: ComboboxOption[] = [{ value: NO_JUMP, label: "不使用（直连）" }];
    for (const c of connections) {
      const isSelf = !!form.id && c.id === form.id;
      // 只支持一跳（同后端 `ssh_save_connection` 的校验）。
      const chained = !!c.proxyJumpId;
      opts.push({
        value: c.id,
        label: `${c.authType === "key" ? "🔑 " : ""}${c.name || c.host}`,
        hint: isSelf
          ? "不能选自己"
          : chained
            ? "已配跳板，不可再作跳板"
            : `${c.username}@${c.host}:${c.port}`,
        disabled: isSelf || chained,
      });
    }
    return opts;
  }, [connections, form.id]);

  const valid =
    form.name.trim() !== "" &&
    form.host.trim() !== "" &&
    form.username.trim() !== "" &&
    form.port > 0 &&
    form.port <= 65535;

  const handleSave = async () => {
    if (!valid) {
      toast("请填写名称、主机、用户名，端口需在 1–65535", "error");
      return;
    }
    setSaving(true);
    try {
      await invoke("ssh_save_connection", {
        args: {
          connection: {
            ...form,
            name: form.name.trim(),
            host: form.host.trim(),
            username: form.username.trim(),
          },
          password:
            form.authType === "key" ? null : form.rememberPassword ? password : null,
          passphrase:
            form.authType === "key" && form.rememberPassphrase ? passphrase : null,
        },
      });
      onSaved();
      onClose();
    } catch (e) {
      toast(`保存失败：${e}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader>
        <DialogTitle>{initial ? "编辑 SSH 连接" : "新建 SSH 连接"}</DialogTitle>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
        >
          <Icon name="close" size={16} />
        </button>
      </DialogHeader>

      <div className="space-y-3.5">
        <Field label="名称">
          <Input
            value={form.name}
            placeholder="例如：生产服务器"
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="主机">
            <Input
              value={form.host}
              placeholder="192.168.1.10 或 example.com"
              onChange={(e) => set("host", e.target.value)}
            />
          </Field>
          <Field label="端口">
            <Input
              type="text"
              inputMode="numeric"
              value={String(form.port)}
              placeholder="22"
              onChange={(e) => {
                // 仅允许数字，过滤步进箭头与非数字输入；空值暂存 0，由 valid 拦截。
                const digits = e.target.value.replace(/[^0-9]/g, "");
                set("port", digits === "" ? 0 : parseInt(digits, 10));
              }}
            />
          </Field>
        </div>
        <Field label="用户名">
          <Input
            value={form.username}
            placeholder="root"
            onChange={(e) => set("username", e.target.value)}
          />
        </Field>

        <Field label="跳板机">
          <Combobox
            fullWidth
            value={form.proxyJumpId}
            options={jumpOptions}
            onChange={(v) => set("proxyJumpId", v)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            目标机连不上、只能从堡垒机进时，选一条已保存的连接作跳板。
            终端、文件浏览、上传下载都会自动经它中转，文件不会在跳板机上落盘。
          </p>
        </Field>

        <SshAuthFields
          form={form}
          set={set}
          initial={initial}
          password={password}
          setPassword={setPassword}
          passphrase={passphrase}
          setPassphrase={setPassphrase}
        />

        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          🔒 密码/密码短语仅在「记住」时于本机加密存储（aes-gcm），明文只经本面板输入，绝不暴露给远程 Claude Code。
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </Button>
      </div>
    </Dialog>
  );
}
