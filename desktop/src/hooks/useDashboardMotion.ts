import { useAppHidden } from "../lib/appVisibility";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/** Dashboard feedback has no animation work while its page or window is hidden. */
export function useDashboardMotion(): boolean {
  const hidden = useAppHidden();
  const reduced = usePrefersReducedMotion();
  return !hidden && !reduced;
}
