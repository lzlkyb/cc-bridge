import { useRef, type HTMLAttributes } from "react";
import { ViewActivityContext, useViewActive } from "../../lib/viewActivity";

/** 首次访问才挂载，离开仅隐藏；表单草稿和滚动位置属于原来的 DOM。 */
export function ActivityPanel({ active, children, className = "", ...props }: HTMLAttributes<HTMLDivElement> & { active: boolean }) {
  const visited = useRef(false);
  const parentActive = useViewActive();
  if (active) visited.current = true;
  if (!visited.current) return null;
  return (
    <ViewActivityContext.Provider value={active && parentActive}>
      <div {...props} hidden={!active} style={{ ...props.style, display: active ? undefined : "none" }} className={className}>
        {children}
      </div>
    </ViewActivityContext.Provider>
  );
}
