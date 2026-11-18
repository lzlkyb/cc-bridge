import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
const local = (name: string) => fileURLToPath(new URL(`./src/design-preview/quick-connect/${name}`, import.meta.url)).replaceAll("\\", "/");

// Production components are imported unchanged; only native IPC/window/update boundaries are fixtures.
export default defineConfig({
  cacheDir: "node_modules/.vite-connection-linkage-check",
  optimizeDeps: { entries: ["quick-connect-preview.html"] },
  plugins: [react(), tailwindcss(), { name: "production-linkage-check", enforce: "pre", resolveId(source, importer) {
    if (source.endsWith("/lib/tauri") || source === "./tauri" && importer?.replaceAll("\\", "/").endsWith("/lib/sshTunnelStore.ts")) return local("linkage/ProductionBackend.ts");
    if (source.endsWith("/contexts/UpdateContext")) return local("mock-update.ts");
    if (source === "@tauri-apps/api/window") return local("mock-window.ts");
  }, transform(_code, id) {
    if (id.replaceAll("\\", "/").endsWith("/quick-connect/main.tsx")) return `import "${local("linkage/ProductionLinkageCheck.tsx")}";`;
  } }],
  server: { host: "127.0.0.1", port: 1437, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/scripts/**"] } },
});
