import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const built = await build({
  configFile: false, root: desktop, plugins: [react(), tailwindcss()],
  build: { write: false, target: "esnext", modulePreload: false, cssCodeSplit: false,
    rollupOptions: { input: path.join(desktop, "terminal-layout-preview.html"), output: { inlineDynamicImports: true } } },
});
const output = (Array.isArray(built) ? built[0] : built).output;
const icon = `data:image/png;base64,${(await readFile(path.join(desktop, "public/icon.png"))).toString("base64")}`;
const js = output.find(file => file.type === "chunk" && file.isEntry).code.replaceAll("/icon.png", icon).replaceAll("</script", "<\\/script");
const css = output.filter(file => file.type === "asset" && file.fileName.endsWith(".css")).map(file => file.source).join("\n");
const target = path.resolve(desktop, "../design/terminal-layout-2026-10-20/real-ui-layout.html");
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CC Bridge · 终端布局设计稿</title><link rel="icon" href="${icon}"><style>${css}</style></head><body><div id="root"></div><script type="module">${js}</script></body></html>`, "utf8");
console.log(target);
const comparison = path.join(path.dirname(target), "real-ui-comparison.html");
await writeFile(comparison, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CC Bridge · 布局前后对照</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f9;color:#0f172a;font-family:system-ui,"Segoe UI",sans-serif}header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 28px;background:white;border-bottom:1px solid #e2e8f0}h1{margin:0;font-size:20px;font-weight:600}header p{margin:6px 0 0;color:#64748b;font-size:13px}a{color:#4f46e5;font-size:13px;text-decoration:none}main{padding:24px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px}section{min-width:0}.caption{display:flex;justify-content:space-between;align-items:center;padding:0 2px 12px}h2{font-size:15px;margin:0}.caption span{font-size:12px;color:#64748b}.viewport{position:relative;width:100%;aspect-ratio:1280/840;overflow:hidden;border:1px solid #dfe3ea;border-radius:10px;background:white}iframe{position:absolute;top:0;left:0;width:1280px;height:840px;border:0;transform-origin:top left}.changes{padding:14px 2px;font-size:13px;color:#475569;line-height:1.8}.changes strong{color:#0f172a}footer{margin:0 24px 24px;padding:16px 20px;background:white;border:1px solid #e2e8f0;border-radius:10px;font-size:13px;color:#475569;line-height:1.8}@media(max-width:1050px){main{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column}}
</style></head><body><header><div><h1>终端工作区 · 布局前后对照</h1><p>同一窗口 1280 × 840，同一配色与默认字号；两侧均为可操作的代码稿。</p></div><a href="real-ui-layout.html?layout=workspace">打开新版完整设计稿 →</a></header><main><section><div class="caption"><h2>当前布局</h2><span>双侧栏 · 三层终端顶区</span></div><div class="viewport"><iframe title="当前终端布局" src="real-ui-layout.html?layout=current&amp;theme=light&amp;capture=1"></iframe></div><div class="changes"><strong>左侧占宽 440px</strong>：200px 全局导航＋240px 连接列表。<br>标签、工具栏和状态栏连续位于终端上方。</div></section><section><div class="caption"><h2>新版 · 单侧栏工作区</h2><span>结构重排 · 原有软件风格</span></div><div class="viewport"><iframe title="新版终端工作区" src="real-ui-layout.html?layout=workspace&amp;theme=light&amp;capture=1"></iframe></div><div class="changes"><strong>左侧合并为 236px</strong>：功能切换与服务器列表放进同一栏。<br>标签与操作合成一行；状态栏下移；终端取消外围卡片留白。</div></section></main><footer>保留现有 Logo、CSS 配色、系统字体、图标和真实终端工具栏。连接条目改为紧凑行，操作收进菜单；双窗格共用顶部工具栏，点击哪一格就操作哪一格。所有会话与输出均为本地示例，正式软件页面未改动。</footer><script>for(const box of document.querySelectorAll('.viewport'))new ResizeObserver(()=>box.querySelector('iframe').style.transform='scale('+box.clientWidth/1280+')').observe(box);</script></body></html>`, "utf8");
console.log(comparison);
