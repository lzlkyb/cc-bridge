/**
 * 跨缩放显示器的 devicePixelRatio 变化监听（DOM 胶水，从 useSshTerminalSession 抽出）。
 *
 * WHY 单独成文件：xterm 的字体度量依赖 dpr，把窗口拖到不同缩放的显示器时度量作废，
 * 必须重量——但这种情况容器尺寸可能不变，ResizeObserver 不会触发，所以得单独监听。
 * matchMedia 只能监听「离开当前 dppx」，所以每次触发后要重新绑定到新值。
 */

/** 监听 dpr 变化，每次变化回调一次（去抖交给调用方）。返回解绑函数。 */
export function watchResolutionChanges(onChange: () => void): () => void {
  let mq: MediaQueryList | null = null;
  const handler = () => {
    watch();
    onChange();
  };
  const watch = () => {
    mq?.removeEventListener("change", handler);
    mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener("change", handler);
  };
  watch();
  return () => mq?.removeEventListener("change", handler);
}
