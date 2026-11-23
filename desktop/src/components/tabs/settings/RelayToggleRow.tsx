import { useState } from "react";
import { invoke } from "../../../lib/tauri";
import type { StaticStatus, RelayEnabledResult } from "../../../lib/types";
import { ToggleRow } from "../../ui/ToggleRow";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { useToast } from "../../ui/toast";

/**
 * 设置 › 网络与接入 ›「启用模型中转」开关（2026-11-23）。
 *
 * 一个开关管两件事：左侧是否出现「中转」页 ＋ 中转服务是否监听（§4.9.1）。
 * 拆成两个开关会产生「服务在跑但页面看不见」「页面在但没有服务」这两种只能
 * 靠翻日志排查的状态，自建单人场景不需要。
 *
 * 为什么单独一个组件：它的状态（保存中 / 错误 / 二次确认）与端口行完全无关，
 * 放在 NetworkGroup 里会把那个文件的 hook 数顶破门禁（规则 7 上限 8 个）。
 *
 * 🔴 开关打开后**不在这里跳页**：此刻 `status` 还没刷新，`relayEnabled` 仍是 false，
 * 跳过去会被 App 的「当前页不可见」兜底立刻弹回来。交给 App 在 relayEnabled
 * 由 false 变 true 的那一刻跳（见 App.tsx 同名 effect）。
 */
export function RelayToggleRow({
  status,
  onSaved,
}: {
  status?: StaticStatus;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const on = status?.relayEnabled === true;

  const apply = async (next: boolean) => {
    setPending(true);
    setError("");
    try {
      const result = await invoke<RelayEnabledResult>("relay_set_enabled", { enabled: next });
      onSaved();
      if (!next) {
        toast("已关闭模型中转，远端已配好的连接会立刻断开", "success");
      } else if (result.error) {
        // 配置写进去了、端口没起来。这个中间态必须留下痕迹，不能把开关弹回去 ——
        // 弹回去会让人以为「开关没生效」，而它其实已经存在、只是没在监听。
        setError(`已启用，但没能开始监听：${result.error}`);
        toast("中转已启用，但监听失败，请重试或换个端口", "warning");
      } else {
        toast(`已开启模型中转，监听在 ${result.addr ?? "127.0.0.1"}`, "success");
      }
    } catch (e) {
      setError(`保存失败：${String(e)}`);
    } finally {
      setPending(false);
      setConfirmOff(false);
    }
  };

  return (
    <>
      <ToggleRow
        id="set-relay-enabled"
        label="启用模型中转"
        // 默认关闭＝功能不可发现，所以这行描述必须点明「会多出什么」（§4.9.4）。
        sub="开启后左侧出现「中转」页"
        info={
          <>
            开启后左侧出现「中转」页，同时开始监听 4100。端口与令牌自动生成，不用填。
            关闭会立刻断开正在使用它的远端会话——已经配好的 <code>claude-own</code> 会连不上，
            直到重新打开。配置与日志都保留，重新打开不用再填一遍。
          </>
        }
        checked={on}
        disabled={!status}
        pending={pending}
        error={error || undefined}
        onChange={(next) => {
          if (!next) {
            setConfirmOff(true);
            return;
          }
          void apply(true);
        }}
      />
      {confirmOff && (
        <ConfirmDialog
          title="关闭模型中转？"
          description={
            <>
              左侧的「中转」页会消失，4100 上的监听会停掉。
              <b>
                远端已经配好的 <code>claude-own</code> 会立刻连不上
              </b>
              ，进行中的请求一起断，直到你重新打开。配置、令牌与日志都保留。
            </>
          }
          variant="destructive"
          confirmLabel="关闭中转"
          onCancel={() => setConfirmOff(false)}
          onConfirm={() => void apply(false)}
        />
      )}
    </>
  );
}
