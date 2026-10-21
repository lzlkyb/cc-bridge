import { build, createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const mock = path.join(root, "src/design-preview/terminal-split-mock.ts");
const options = { configFile: false, root, plugins: [react(), tailwindcss(), {
  name: "local-terminal-preview", enforce: "pre",
  resolveId(source) { if (source.endsWith("/lib/tauri")) return mock; },
}] };
if (process.argv.includes("--serve")) {
  const server = await createServer({ ...options, server: { host: "127.0.0.1", port: 1431, strictPort: true } });
  await server.listen();
  console.log("http://127.0.0.1:1431/terminal-split-preview.html");
} else {
  const built = await build({ ...options, build: { write: false, target: "esnext", modulePreload: false, cssCodeSplit: false,
    rollupOptions: { input: path.join(root, "terminal-split-preview.html"), output: { inlineDynamicImports: true } } } });
  const output = (Array.isArray(built) ? built[0] : built).output;
  const icon = `data:image/png;base64,${(await readFile(path.join(root, "public/icon.png"))).toString("base64")}`;
  let js = output.find(f => f.type === "chunk" && f.isEntry).code.replaceAll("/icon.png", icon).replaceAll("</script", "<\\/script");
  let css = output.filter(f => f.type === "asset" && f.fileName.endsWith(".css")).map(f => f.source).join("\n");
  for (const asset of output.filter(f => f.type === "asset" && f.fileName.endsWith(".ttf"))) {
    const uri = `data:font/ttf;base64,${Buffer.from(asset.source).toString("base64")}`;
    css = css.replaceAll(`/${asset.fileName}`, uri);
    js = js.replaceAll(`/${asset.fileName}`, uri);
  }
  const folder = path.resolve(root, "../design/terminal-split-2026-10-20");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "index.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CC Bridge · 分屏交互预览</title><style>${css}</style></head><body><div id="root"></div><script type="module">${js}</script></body></html>`, "utf8");
  console.log(path.join(folder, "index.html"));
}
