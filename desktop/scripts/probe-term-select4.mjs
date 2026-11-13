/**
 * 探针 v4：验证 A 方案（pointerdown 即闭闸 + 松手补一次完整点击）在真 xterm 6 上的行为。
 *
 * 与 v3 的差别只有一处：**闭闸时机从「越过 4px」提前到 pointerdown**，以及松手时的补偿。
 * v3 已经证明：4px 之前泄漏的按下/移动报告会让远端 TUI 重绘，并且
 * `triggerDataEvent(report, true)` 里的 `scrollOnUserInput` 会把滚上去的视口弹回底部。
 *
 * 本探针要证明的新结论：
 *   1. 拖选全程 `reports === 0`（一条鼠标报告都没外泄）；
 *   2. 滚上去起手时视口**不动**，选区起点仍等于按下点；
 *   3. 普通点击不会丢：闸开之后恰好补出 press + release 两条，坐标等于按下点；
 *   4. 远端持续输出（模拟 Claude Code 流式重绘）时，选区仍然建得起来且长度单调增长。
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "design/chat-workspace-2026-10-27/.qa/package.json"));
const { chromium } = require("playwright");
const NM = path.join(root, "desktop/node_modules/@xterm");

const html = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/xterm/css/xterm.css">
<style>
  html,body{margin:0;height:100%;background:#1e1e2e;color:#cdd6f4;font-family:monospace}
  body{display:flex}
  #side{width:300px;background:#11111b;transition:width 300ms cubic-bezier(.4,0,.2,1)}
  #side.collapsed{width:56px}
  #main{flex:1;min-width:0;min-height:0}
  #wrap{height:100%;padding:8px;box-sizing:border-box;overflow:hidden}
  #term{height:100%;width:100%}
</style>
<div id="side"></div>
<div id="main"><div id="wrap"><div id="term"></div></div></div>
<script src="/xterm/lib/xterm.js"></script>
<script src="/addon-fit/lib/addon-fit.js"></script>
<script>
window.__log = { resizes: [], sels: [], fits: 0, reports: [], reportAt: [] };
const term = new Terminal({ fontSize: 14, lineHeight: 1.2, cursorBlink: false, allowProposedApi: true, scrollback: 5000 });
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('term'));

function doFit() {
  const box = document.getElementById('term');
  if (!box.clientWidth || !box.clientHeight) return;
  try { fitAddon.fit(); } catch { return; }
  window.__log.fits++;
}
new ResizeObserver(() => requestAnimationFrame(doFit)).observe(document.getElementById('term'));
term.onResize(() => window.__log.resizes.push([term.cols, term.rows]));
term.onSelectionChange(() => window.__log.sels.push(term.getSelection().length));
window.__trace = [];
term.onData(d => { window.__log.reports.push(d); window.__log.reportAt.push(performance.now()); window.__trace.push(['report', JSON.stringify(d)]); });

const lines = [];
for (let i = 0; i < 400; i++) {
  lines.push('\\x1b[36m' + String(i + 1).padStart(3, ' ') + '\\x1b[0m  line-' + (i + 1) + ' ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 marker-' + i);
}
term.write(lines.join('\\r\\n') + '\\x1b[?1003h\\x1b[?1006h', () => { doFit(); window.__ready = true; });

// ── 复刻 app 的**新**路径（A 方案）──
const screenEl = () => term.element.querySelector('.xterm-screen');
const tracking = () => term.modes.mouseTrackingMode !== 'none';
const box = () => document.getElementById('term');
let down = null, active = false, heldFromDown = false;

function forceSelectAt(x, y) {
  if (!tracking()) return;
  screenEl().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1, detail: 1, shiftKey: true, altKey: false }));
}
function replayClick(x, y) {
  const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, detail: 1 };
  screenEl().dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
  screenEl().dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
}
window.addEventListener('mousedown', () => window.__trace.push(['mousedown', term.options.disableStdin]), true);
box().addEventListener('pointerdown', (e) => {
  window.__trace.push(['pointerdown', term.options.disableStdin]);
  if (e.button !== 0) return;
  down = { x: e.clientX, y: e.clientY }; active = false;
  heldFromDown = false;
  if (tracking()) { term.options.disableStdin = true; heldFromDown = true; }  // ← A 方案：起手即闭闸
}, true);
window.addEventListener('pointermove', (e) => {
  if (!down || active || !(e.buttons & 1)) return;
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) return;
  active = true;
  forceSelectAt(down.x, down.y);   // 闸已闭 ⇒ 不补 mouseup
});
window.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  const wasActive = active;
  const { x, y } = down ?? { x: 0, y: 0 };
  down = null; active = false;
  setTimeout(() => {
    term.options.disableStdin = false;
    if (!wasActive && heldFromDown) replayClick(x, y);   // 普通点击：开闸后补一次完整点击
    heldFromDown = false;
  }, 0);
});

window.__setSide = (c) => document.getElementById('side').classList.toggle('collapsed', c);
window.__scrollUp = (n) => { term.scrollLines(-n); };
window.__ydisp = () => ({ ydisp: term.buffer.active.viewportY, ybase: term.buffer.active.baseY });
window.__sel = () => ({ len: term.getSelection().length, text: term.getSelection(), cols: term.cols, rows: term.rows });
window.__log_ = () => window.__log;
window.__stream = null;
window.__startStream = (ms) => {
  let n = 400;
  window.__stream = setInterval(() => {
    n++;
    term.write('\\r\\n\\x1b[32mstream-' + n + '\\x1b[0m  模型输出片段…… ' + 'x'.repeat(n % 60));
  }, ms);
};
window.__stopStream = () => { if (window.__stream) clearInterval(window.__stream); window.__stream = null; };
window.__cellAt = (x, y) => {
  const r = screenEl().getBoundingClientRect();
  return { col: Math.floor((x - r.left) / (r.width / term.cols)), row: Math.floor((y - r.top) / (r.height / term.rows)) };
};
window.__lineTextAbs = (absRow) => { const l = term.buffer.active.getLine(absRow); return l ? l.translateToString(true) : null; };
</script>`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/" || req.url.startsWith("/index")) {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(html);
    }
    const f = req.url.replace(/^\//, "").split("?")[0];
    const buf = await readFile(path.join(NM, f));
    res.setHeader("content-type", f.endsWith(".css") ? "text/css" : "application/javascript");
    res.end(buf);
  } catch (e) { res.statusCode = 404; res.end(String(e)); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const out = {};

async function open({ collapsed = false, stream = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForFunction("window.__ready === true", null, { timeout: 15000 });
  if (collapsed) { await page.evaluate("window.__setSide(true)"); await page.waitForTimeout(600); }
  if (stream) { await page.evaluate(`window.__startStream(${stream})`); await page.waitForTimeout(80); }
  return { page, errors };
}

/** 普通点击（不动）：证明 A 方案的补偿没把点击弄丢。 */
async function runClick({ scrollUp = 20 } = {}) {
  const { page, errors } = await open({ collapsed: true });
  const rect = await page.locator("#term").boundingBox();
  const x = rect.x + 120, y = rect.y + 120;
  await page.mouse.move(x, y);            // 先把 hover 报告消化掉（?1003h 下移动也会发报告）
  await page.waitForTimeout(120);
  if (scrollUp) { await page.evaluate(`window.__scrollUp(${scrollUp})`); await page.waitForTimeout(120); }
  const pre = await page.evaluate("window.__ydisp()");
  const reportsBeforePress = await page.evaluate("window.__log_().reports.length");
  await page.mouse.down();
  await page.waitForTimeout(60);
  const duringDown = await page.evaluate("window.__ydisp()");
  const reportsDuring = await page.evaluate("window.__log_().reports.length");
  await page.mouse.up();
  await page.waitForTimeout(200);
  const log = await page.evaluate("window.__log_()");
  const trace = await page.evaluate("window.__trace");
  await page.close();
  return {
    trace,
    ydispBefore: pre.ydisp,
    viewJumpedToBottom: duringDown.ydisp !== pre.ydisp,
    reportsBeforePress,
    reportsDuringPress: reportsDuring,
    reportsTotal: log.reports.length,
    reportRaw: log.reports,
    errors,
  };
}

/** 拖选：选区长度 + 起点是否等于按下点 + 全程是否外泄报告 + 视口是否被弹走。 */
async function runDrag({ collapsed = true, scrollUp = 0, stream = 0 } = {}) {
  const { page, errors } = await open({ collapsed, scrollUp, stream });
  const rect = await page.locator("#term").boundingBox();
  const x1 = rect.x + 90, y1 = rect.y + 90;
  const x2 = rect.x + Math.min(520, rect.width - 60), y2 = rect.y + 200;

  await page.mouse.move(x1, y1);          // 先落位：把 hover 报告留在「未滚动」状态
  await page.waitForTimeout(120);
  if (scrollUp) { await page.evaluate(`window.__scrollUp(${scrollUp})`); await page.waitForTimeout(120); }
  const pre = await page.evaluate("window.__ydisp()");
  const cell = await page.evaluate("window.__cellAt(" + x1 + "," + y1 + ")");
  const wantLine = await page.evaluate("window.__lineTextAbs(" + (pre.ydisp + cell.row) + ")");
  const want = wantLine ? wantLine.slice(cell.col, cell.col + 8) : null;

  await page.mouse.down();
  await page.waitForTimeout(60);
  const afterDown = await page.evaluate("window.__ydisp()");
  const timeline = [];
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    await page.mouse.move(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
    await page.waitForTimeout(45);
    timeline.push(await page.evaluate("window.__sel().len"));
  }
  await page.mouse.up();
  if (stream) await page.evaluate("window.__stopStream()");
  await page.waitForTimeout(300);
  const after = await page.evaluate("window.__sel()");
  const log = await page.evaluate("window.__log_()");
  const firstLine = (after.text.split("\n")[0] ?? "").trim();
  await page.close();
  return {
    ydispBefore: pre.ydisp, ybase: pre.ybase,
    viewJumpedToBottom: afterDown.ydisp !== pre.ydisp,
    startMatches: !!want && firstLine.includes(want.trim()),
    wantStart: want, gotStart: firstLine.slice(0, 40),
    pressAbsRow: pre.ydisp + cell.row, col: cell.col, cellRow: cell.row,
    lineAtPress: (wantLine ?? "").slice(0, 40),
    firstLineFull: firstLine.slice(0, 40),
    selHead: after.text.split("\n").slice(0, 2).map((l) => l.slice(0, 40)),
    selLen: after.len, timeline,
    shrunkMidDrag: timeline.some((v, i) => i > 0 && v < timeline[i - 1]),
    reportsLeaked: log.reports.length,
    errors,
  };
}

try {
  out.click = await runClick();
  out.dragAtBottom = await runDrag({ scrollUp: 0 });
  out.dragScrolledUp = await runDrag({ scrollUp: 20 });
  out.dragStreaming = await runDrag({ scrollUp: 0, stream: 60 });
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify(out, null, 2));
