import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const result = await build({
  absWorkingDir: desktop,
  entryPoints: ["src/design-preview/main.tsx"],
  bundle: true,
  format: "iife",
  outdir: "preview-bundle",
  write: false,
  minify: true,
  define: { "process.env.NODE_ENV": '"production"', "import.meta.hot": "undefined" },
});
const icon = `data:image/png;base64,${(await readFile(path.join(desktop, "public/icon.png"))).toString("base64")}`;
// Embed assets so the review copy can be opened without a dev server or network.
const js = result.outputFiles.find(f => f.path.endsWith(".js")).text.replaceAll("/icon.png", icon).replaceAll("</script", "<\\/script");
const css = result.outputFiles.find(f => f.path.endsWith(".css")).text;
const target = path.resolve(desktop, "../design/2026-10-16-workbench.html");
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CC Bridge · 工作台设计预览</title><link rel="icon" href="${icon}"><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`, "utf8");
console.log(target);
