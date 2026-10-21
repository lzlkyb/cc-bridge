import { useState } from "react";

/** Local preferences apply even when persistence fails; never report that case as saved. */
export function useTerminalSettingFeedback() {
  const [results, setResults] = useState<Record<string, boolean>>({});
  const apply = (key: string, update: () => boolean) => {
    const saved = update();
    setResults(current => ({ ...current, [key]: saved }));
  };
  return {
    apply,
    isSaved: (key: string) => results[key] === true,
    errorFor: (key: string) => results[key] === false ? "本次生效，未能记住选择。请检查本机存储后重试。" : undefined,
  };
}
