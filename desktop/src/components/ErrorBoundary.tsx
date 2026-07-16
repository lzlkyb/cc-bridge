import { Component, type ErrorInfo, type ReactNode } from "react";
import { Icon } from "./ui/icon";
import { Button } from "./ui/button";

/**
 * 全局错误边界（P0-4）：捕获子组件渲染异常，显示友好占位页而非白屏。
 * WHY：此前各组件 invoke 失败是散落的 catch/toast，没有统一兜底。
 * ErrorBoundary 捕获 React 渲染生命周期中的同步错误，配合 ConnectionAlert
 * （状态拉取失败提示条）形成完整的异常兜底体系。
 */
interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined });
  };

  // H9 修复：「重新加载」只重置 React 状态，若崩溃根源是持久化查询缓存/外部状态，很可能立即复现；
  // 再提供一个真正刷新整个页面的最后手段。
  handleFullReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
            <Icon name="alertTriangle" size={32} className="text-destructive" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold text-foreground">应用遇到错误</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              页面渲染过程中发生了异常。可以尝试重新加载，如果问题持续请重启应用。
            </p>
          </div>
          {this.state.error?.message && (
            <pre className="max-w-lg overflow-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
              {this.state.error.message}
            </pre>
          )}
          <div className="flex items-center gap-2">
            <Button onClick={this.handleRetry}>
              <Icon name="refresh" size={16} />
              重新加载
            </Button>
            <Button variant="outline" onClick={this.handleFullReload}>
              <Icon name="refresh" size={16} />
              完全刷新
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
