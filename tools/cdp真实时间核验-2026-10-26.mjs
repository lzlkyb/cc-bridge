// 用 CDP 打开页面，等真实时间后求值 / 截图。
//
// 为什么不用 `msedge --headless --screenshot/--dump-dom`：
//   - `--virtual-time-budget` 会让页面在「异步解码/编码还没完成」时被冻结并 dump，
//     实测图片编码这条链路永远看不到结果（chip 停在骨架态）；
//   - 不带 budget 又会在 effect 跑完前就 dump（chip 一个都没有）。
// 两者都会给出错误结论，所以必须用 CDP 走真实时间。
//
// 用法：
//   node tools/cdp真实时间核验-2026-10-26.mjs <url> <evalExpr> [waitMs] [shotPath] [w] [h]
// 需要先起一个带 --remote-debugging-port=9223 的 Edge headless。
const [, , url, expr = "document.body.innerText", waitMs = "4000", shot, w = "1000", h = "1600"] =
  process.argv;
const PORT = 9223;

async function j(path, init) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  return r.json();
}

const target = await j(`/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
await new Promise((r) => ws.addEventListener("open", r));

await send("Emulation.setDeviceMetricsOverride", {
  width: Number(w),
  height: Number(h),
  deviceScaleFactor: 1,
  mobile: false,
});
// 固定等真实时间再取一次：轮询 + 关键字 break 会被返回值里的普通单词误触发。
await new Promise((r) => setTimeout(r, Number(waitMs)));

if (shot) {
  await send("Page.enable");
  const res = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(shot, Buffer.from(res.result.data, "base64"));
  console.log(`screenshot -> ${shot}`);
} else {
  const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  console.log(String(res.result?.result?.value ?? ""));
}

await j(`/json/close/${target.id}`).catch(() => {});
process.exit(0);
