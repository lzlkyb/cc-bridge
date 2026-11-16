import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const built = await build({
  configFile: false, root: desktop, plugins: [react(), tailwindcss()],
  build: {
    write: false, target: "esnext", modulePreload: false, cssCodeSplit: false,
    assetsInlineLimit: Infinity,
    rollupOptions: { input: path.join(desktop, "forward-preview.html"), output: { inlineDynamicImports: true } },
  },
});
const output = (Array.isArray(built) ? built[0] : built).output;
const icon = "data:image/png;base64," + (await readFile(path.join(desktop, "public/icon.png"))).toString("base64");
const entry = output.find(file => file.type === "chunk" && file.isEntry);
if (!entry) throw new Error("Preview entry was not generated.");
const js = entry.code.replaceAll("/icon.png", icon).replaceAll("</script", "<\\/script");
const css = output.filter(file => file.type === "asset" && file.fileName.endsWith(".css")).map(file => file.source).join("\n");
const target = path.resolve(desktop, "../design/2026-11-15-port-forward/preview.html");
await mkdir(path.dirname(target), { recursive: true });
const html = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>CC Bridge · 端口转发交互设计稿</title><link rel="icon" href="' + icon + '"><style>' + css + '</style></head>',
  '<body><div id="root"></div><script type="module">' + js + '</script></body></html>',
].join("");
await writeFile(target, html, "utf8");
console.log(target);
