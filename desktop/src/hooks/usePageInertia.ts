import { useEffect } from "react";
import { attachPageInertia } from "../lib/pageInertia";

/** Includes late-mounted content and portal panels without remounting their scroll positions. */
export function usePageInertia() {
  useEffect(() => attachPageInertia(document), []);
}
