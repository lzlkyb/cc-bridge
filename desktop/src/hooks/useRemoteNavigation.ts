import { useCallback, useState } from "react";

/** Directory history belongs to this file browser, not the terminal's shell or browser history. */
export function useRemoteNavigation(initialPath: string) {
  const [history, setHistory] = useState(() => ({ paths: [initialPath], index: 0 }));
  const navigate = useCallback((path: string) => setHistory(old => old.paths[old.index] === path ? old : {
    paths: [...old.paths.slice(0, old.index + 1), path], index: old.index + 1,
  }), []);
  // Initial file links fall back to their parent; that file must not become a Back destination.
  const replace = useCallback((path: string) => setHistory(old => {
    const paths = [...old.paths]; paths[old.index] = path;
    return { ...old, paths };
  }), []);
  const back = () => setHistory(old => old.index > 0 ? { ...old, index: old.index - 1 } : old);
  const forward = () => setHistory(old => old.index < old.paths.length - 1 ? { ...old, index: old.index + 1 } : old);
  return { path: history.paths[history.index], navigate, replace, back, forward, canBack: history.index > 0, canForward: history.index < history.paths.length - 1 };
}
