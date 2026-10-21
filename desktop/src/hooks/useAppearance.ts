import { useSyncExternalStore } from "react";
import { getAppearance, subscribeAppearance } from "../lib/appearance";

export function useAppearance() {
  return useSyncExternalStore(subscribeAppearance, getAppearance, () => "classic" as const);
}
