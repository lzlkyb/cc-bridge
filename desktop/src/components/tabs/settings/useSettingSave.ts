import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../../../lib/tauri";
import type { ConfigSaveResult } from "../../../lib/types";
import { useToast } from "../../ui/toast";

/**
 * 设置项保存 + 「已保存 ✓」行内反馈。拆卡后四张设置卡共用这一份，
 * 不让每张卡各写一遍 save。
 *
 * `savedKey` 用于定位反馈落在哪一行（同一张卡里多个开关共用一个 state）。
 *
 * try/catch 不能省：之前无 catch 时保存失败会静默抛未处理 rejection，
 * 开关看似生效实则未落盘。
 */
export function useSettingSave(onSaved: () => void) {
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const { toast } = useToast();
  // 卸载后不能再 setState；原实现的 setTimeout 没人清，切页签后仍会触发
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const save = useCallback(
    async (patch: Record<string, unknown>, key?: string) => {
      try {
        await invoke<ConfigSaveResult>("save_config", { patch });
        onSaved();
        if (key) {
          setSavedKey(key);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(
            () => setSavedKey((cur) => (cur === key ? null : cur)),
            1500,
          );
        }
      } catch (e) {
        toast(`保存失败：${e}`, "error");
      }
    },
    [onSaved, toast],
  );

  return { savedKey, save };
}
