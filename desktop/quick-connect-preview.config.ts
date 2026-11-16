import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
const local = (name: string) => fileURLToPath(new URL(`./src/design-preview/quick-connect/${name}`, import.meta.url)).replaceAll("\\", "/");
// Dedicated preview build: native calls can never reach the user's real configuration.
export default defineConfig({
  plugins: [react(), tailwindcss(), { name: "quick-connect-preview-adapter", enforce: "pre", resolveId(source) {
    if (source.endsWith("/lib/tauri")) return local("mock.ts");
    if (source.endsWith("/contexts/UpdateContext")) return local("mock-update.ts");
    if (source === "@tauri-apps/api/window") return local("mock-window.ts");
  }, transform(code, id) {
    if (id.replaceAll("\\", "/").endsWith("/components/layout/SideNav.tsx")) return `import { useOptionalLinkage } from "${local("linkage/context.tsx")}";\n` + code
      .replace("const linkDown =", "const linkage = useOptionalLinkage();\n  const linkDown =")
      .replace('const statusTone = startupError || linkDown ? "bad" : !running ? "idle" : firewallBlocked ? "warn" : "ok";', 'const statusTone = linkage ? ({ live: "ok", warn: "warn", error: "bad", stopped: "idle" } as const)[linkage.summary.tone] : startupError || linkDown ? "bad" : !running ? "idle" : firewallBlocked ? "warn" : "ok";')
      .replace("const statusText = !status", 'const statusText = linkage ? `${linkage.summary.methodLabel} · ${linkage.summary.short}` : !status')
      .replace('const statusTarget = startupError ? "settings" : linkDown || firewallBlocked ? "connect" : null;', 'const statusTarget = linkage ? "connect" : startupError ? "settings" : linkDown || firewallBlocked ? "connect" : null;')
      .replace("const statusTitle = startupError", "const statusTitle = linkage ? linkage.summary.detail : startupError")
      .replace('const pillShown = statusTone === "bad" || statusTone === "warn";', 'const pillShown = linkage ? linkage.summary.tone !== "live" : statusTone === "bad" || statusTone === "warn";');
    if (id.replaceAll("\\", "/").endsWith("/components/tabs/ConnectBento.tsx")) return code.replace('from "./StatusCard"', `from "${local("linkage/PreviewAdapters.tsx")}"`);
    if (id.replaceAll("\\", "/").endsWith("/components/tabs/ConnectTab.tsx")) return code
      .replace('from "./connect/StableConnectionMethod"', `from "${local("linkage/PreviewAdapters.tsx")}"`)
      .replace('from "./connect/StableAccessGuide"', `from "${local("linkage/PreviewAdapters.tsx")}"`)
      .replace('from "./connect/ConnectGuide"', `from "${local("linkage/PreviewAdapters.tsx")}"`);
    // Keep the incumbent page exact; adapt only the obsolete guidance in the proposed flow.
    if (id.replaceAll("\\", "/").endsWith("/components/tabs/StatusCard.tsx")) return code.replace("{chain.sub}</p>", '{document.documentElement.dataset.quickConnect === "true" && chain.sub.startsWith("展开下方") ? "本机服务已就绪，等待 Claude Code 发起调用" : chain.sub}</p>');
  } }],
  server: { host: "127.0.0.1", port: 1436, strictPort: true },
  build: { target: "esnext", modulePreload: false, cssCodeSplit: false, rollupOptions: { input: "quick-connect-preview.html", output: { inlineDynamicImports: true } } },
});
