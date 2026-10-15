import { useRef, type ReactNode } from "react";
import { ViewActivityContext, useViewActive } from "../../lib/viewActivity";

/** 网格高度可中途反向，收起内容不抢焦点；首次展开前不启动子组件。 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const visited = useRef(false);
  const active = useViewActive();
  if (open) visited.current = true;
  return <div className="ui-collapse" data-open={open} aria-hidden={!open} ref={node => { if (node) node.inert = !open; }}><div className="ui-collapse-inner"><ViewActivityContext.Provider value={active && open}>{visited.current ? children : null}</ViewActivityContext.Provider></div></div>;
}
