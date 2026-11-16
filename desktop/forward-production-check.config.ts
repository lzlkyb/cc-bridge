import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const fixture = (name: string) => fileURLToPath(new URL(`./src/design-preview/port-forward/production/${name}`, import.meta.url)).replaceAll("\\", "/");

// The shipped panel is imported unchanged; only the native server boundary is simulated.
export default defineConfig({
  cacheDir: "node_modules/.vite-forward-production-check",
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: { entries: ["src/design-preview/port-forward/production/ProductionCheck.tsx"] },
  plugins: [react(), tailwindcss(), {
    name: "production-forward-check", enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith("/lib/tauri") || source === "./tauri" && importer?.replaceAll("\\", "/").includes("/src/lib/")) return fixture("ProductionBackend.ts");
    },
    transform(_code, id) {
      if (id.replaceAll("\\", "/").endsWith("/port-forward/main.tsx")) return `import "${fixture("ProductionCheck.tsx")}";`;
    },
  }],
  server: { host: "127.0.0.1", port: 1449, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/scripts/**"] } },
});
