import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../../../lib/tauri";
import type { ConfigSaveResult } from "../../../lib/types";
import { useToast } from "../../ui/toast";

type SaveState = { pending?: boolean; saved?: boolean; error?: string };

/** 每项独立反馈；明确返回结果，调用方才能在保存失败时停止重启等后续动作。 */
export function useSettingSave(onSaved: () => void) {
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, SaveState>>({});
  const { toast } = useToast();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pending = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const activeTimers = timers.current;
    return () => { mounted.current = false; activeTimers.forEach(clearTimeout); };
  }, []);

  const save = useCallback(
    async (patch: Record<string, unknown>, key = Object.keys(patch).sort().join("|")): Promise<boolean> => {
      // 同一设置保存期间不再提交第二次；其它独立设置不受影响。
      if (pending.current.has(key)) return false;
      pending.current.add(key);
      clearTimeout(timers.current.get(key));
      setSavedKey(cur => cur === key ? null : cur);
      setStates(cur => ({ ...cur, [key]: { pending: true } }));
      try {
        await invoke<ConfigSaveResult>("save_config", { patch });
        onSaved();
        if (mounted.current) {
          setStates(cur => ({ ...cur, [key]: { saved: true } }));
          setSavedKey(key);
          timers.current.set(key, setTimeout(() => {
            timers.current.delete(key);
            setStates(cur => ({ ...cur, [key]: {} }));
            setSavedKey(cur => cur === key ? null : cur);
          }, 1500));
        }
        return true;
      } catch (e) {
        const error = `保存失败：${e}`;
        if (mounted.current) setStates(cur => ({ ...cur, [key]: { error } }));
        toast(error, "error");
        return false;
      } finally {
        pending.current.delete(key);
      }
    },
    [onSaved, toast],
  );

  return {
    savedKey, save,
    pendingKeys: Object.keys(states).filter(key => states[key].pending),
    savedKeys: Object.keys(states).filter(key => states[key].saved),
    errors: Object.fromEntries(Object.entries(states).filter(([, state]) => state.error).map(([key, state]) => [key, state.error!])),
    isPending: (key: string) => !!states[key]?.pending,
    isSaved: (key: string) => !!states[key]?.saved,
    errorFor: (key: string) => states[key]?.error,
  };
}
