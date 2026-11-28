import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UpdateProvider } from "./contexts/UpdateContext";
import { ForceUpdateGate } from "./components/update/ForceUpdateGate";
import { getStoredTheme } from "./lib/theme";
import { initializeAppearance } from "./lib/appearance";
import { installGlobalErrorReporting, reportUiError } from "./lib/uiErrorReport";
import "./index.css";
// 独立模块导入保证 Vite 开发注入与生产构建都包含补充样式。
import "./interaction-refinements.css";
import "./appearance.css";

// 必须在最前面：之后任何一行抛错（主题、外观、provider 初始化）都要能留下痕迹。
// release 版没有 devtools，这条通道是白屏问题唯一的前端侧证据。
installGlobalErrorReporting();

// 启动即应用已保存的主题，避免首帧闪烁。
document.documentElement.classList.toggle("dark", getStoredTheme() === "dark");
initializeAppearance();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 3000, // E-P1-8: 3s 内复用缓存，避免 5s 轮询强制重新 fetch
    },
  },
});

/**
 * React 完全没起来时的最后一道兜底。
 *
 * 为什么不能用组件：能走到这里，说明「渲染」这件事本身已经不成立了。这段必须是纯 DOM +
 * 内联样式，不依赖 Tailwind（它可能正是没加载成功的那个），也不依赖任何组件。
 */
function renderBootstrapFailure(root: HTMLElement, error: unknown): void {
  reportUiError("bootstrap", error, "React 根节点渲染失败");
  try {
    root.innerHTML = `
      <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:32px;text-align:center;font:14px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#334155;background:#f4f6f9">
        <div style="font-size:16px;font-weight:600">界面没能正常加载</div>
        <div style="max-width:420px;color:#64748b">可以点下面的按钮重新加载。如果反复出现，请退出后重新打开应用。</div>
        <button id="ccb-boot-retry" type="button" style="padding:8px 18px;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-size:14px;cursor:pointer">重新加载</button>
      </div>`;
    root.querySelector("#ccb-boot-retry")?.addEventListener("click", () => {
      window.location.reload();
    });
  } catch {
    // 连兜底 DOM 都写不进去（root 被冻结之类），只能留下日志。
  }
}

const container = document.getElementById("root");

if (!container) {
  // 结构被改坏 / 资源没加载全。直接报给后端，别让用户对着一片空白猜。
  reportUiError("bootstrap", new Error("#root 不存在，前端页面结构可能未正确加载"));
} else {
  try {
    ReactDOM.createRoot(container).render(
      <React.StrictMode>
        {/*
          ErrorBoundary 必须在 provider 外层。
          原先它只包 <App />，而 QueryClientProvider / UpdateProvider / ForceUpdateGate 在它
          外面——这几个在渲染或 effect 里抛错时，React 会卸载整棵树，结果是**纯白屏，
          连「应用遇到错误」都出不来**。这正是「只能托盘退出重开」那一类白屏的形态。
        */}
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <UpdateProvider>
              <App />
              {/* 强制更新遮罩挂在 App 之外：它必须盖住所有路由与浮层，而不是只盖某一页。 */}
              <ForceUpdateGate />
            </UpdateProvider>
          </QueryClientProvider>
        </ErrorBoundary>
      </React.StrictMode>,
    );
  } catch (error) {
    renderBootstrapFailure(container, error);
  }
}
