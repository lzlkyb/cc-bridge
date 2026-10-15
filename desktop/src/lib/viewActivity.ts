import { createContext, useContext } from "react";

/** 保留页面状态时仍让隐藏页面停止轮询、快捷键和定位副作用。 */
export const ViewActivityContext = createContext(true);
export function useViewActive(): boolean {
  return useContext(ViewActivityContext);
}
