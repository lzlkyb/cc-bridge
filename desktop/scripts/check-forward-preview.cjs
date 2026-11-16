/* global window, navigator, document */
const { chromium } = require("playwright");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const fs = require("node:fs");
const destination = path.resolve(__dirname, "../../design/2026-11-15-port-forward");
const base = process.env.CCBRIDGE_FORWARD_PREVIEW_URL || "http://localhost:1420/forward-preview.html";
const results = [], errors = [], layouts = [];
const visualOnly = process.argv.includes("--visual-only");
let browser;
const assert = (value, message) => { if (!value) throw new Error(message); };

(async () => {
  fs.mkdirSync(destination, { recursive: true });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } });
  await context.addInitScript(() => {
    window.previewCopies = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.previewCopies.push(value); } } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (response.status() >= 400) errors.push(response.status() + " " + response.url()); });
  const scenario = async value => {
    await page.getByLabel("演示场景", { exact: true }).selectOption(value);
    await page.locator(".fp-page h1").waitFor();
  };
  const check = async (label, test) => {
    if (visualOnly) return;
    try { await test(); results.push({ label, passed: true }); }
    catch (error) { results.push({ label, passed: false, error: String(error) }); }
  };
  const rule = () => page.locator(".fp-rule").first();
  const address = () => rule().locator(".fp-use-address code").innerText();
  const running = () => rule().locator('..').locator('.fp-rule[data-phase="running"]').first().waitFor();
  const copyValue = () => page.evaluate(() => window.previewCopies.at(-1));
  await page.goto(base);
  await page.locator(".fp-rule").waitFor();

  await check("默认按结果展示，明确在服务器上使用 7824", async () => {
    assert(await address() === "127.0.0.1:7824", "wrong address");
    assert((await rule().innerText()).includes("在服务器上使用这个地址"), "device not stated");
    assert(await page.locator(".fp-page input:visible").count() === 0, "technical fields exposed");
    await rule().getByRole("button", { name: "复制使用地址" }).click();
    assert(await copyValue() === "127.0.0.1:7824", "wrong copied address");
  });
  await check("管理接入往返，托管状态同步且手动规则保留", async () => {
    await page.getByRole("button", { name: "管理接入", exact: true }).click();
    await page.getByRole("button", { name: "恢复隧道", exact: true }).click();
    await page.getByRole("button", { name: "返回端口转发", exact: true }).click();
    assert((await page.locator(".fp-managed-row").innerText()).includes("已连通"), "managed status differs");
    assert(await address() === "127.0.0.1:7824", "manual rule lost");
  });
  await check("两个用途同等可发现，本机访问只需两个必要端口", async () => {
    await scenario("first");
    assert(await page.locator(".fp-purpose-option").count() === 2, "purpose choices missing");
    const widths = await page.locator(".fp-purpose-option").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
    assert(Math.abs(widths[0] - widths[1]) < 1, "directions have unequal priority");
    await page.getByRole("button", { name: /在本机访问服务器服务/ }).click();
    assert(!await page.getByLabel("服务地址", { exact: true }).isVisible(), "advanced address exposed");
    await page.getByLabel("服务器上的服务端口", { exact: true }).fill("3000");
    assert(await page.getByLabel("在本机使用的端口", { exact: true }).inputValue() === "3000", "port suggestion missing");
    await page.getByRole("button", { name: "仅保存配置", exact: true }).click();
    assert(await rule().getAttribute("data-phase") === "stopped", "save started forwarding");
    await rule().getByRole("button", { name: "开启转发", exact: true }).click();
    await running();
    assert((await rule().innerText()).includes("在本机上使用这个地址"), "local direction mislabeled");
  });
  await check("反向转发避免占用托管 7823，建议 7824 并展示加载状态", async () => {
    await scenario("remote");
    await page.getByLabel("本机上的服务端口", { exact: true }).fill("7823");
    assert(await page.getByRole("button", { name: "保存并开启", exact: true }).isDisabled(), "conflict not blocked");
    await page.getByRole("button", { name: /使用建议端口 7824/ }).click();
    await page.getByRole("button", { name: "保存并开启", exact: true }).click();
    assert(await page.getByLabel("本机上的服务端口", { exact: true }).isDisabled(), "editable while applying");
    await running();
    assert(await address() === "127.0.0.1:7824", "wrong remote endpoint");
  });
  await check("仅保存更改保留实际地址，应用后才更新", async () => {
    await scenario("running");
    await rule().getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByLabel("在服务器使用的端口", { exact: true }).fill("7825");
    await page.getByRole("button", { name: "仅保存配置", exact: true }).click();
    assert(await address() === "127.0.0.1:7824", "unapplied address replaced live endpoint");
    assert((await rule().locator(".fp-rule-pending").innerText()).includes("127.0.0.1:7825"), "draft endpoint not explained");
    await rule().getByRole("button", { name: "应用更改", exact: true }).click();
    await running();
    assert(await address() === "127.0.0.1:7825", "endpoint not updated");
  });
  await check("重连时保存更改仍保留原地址", async () => {
    await scenario("reconnecting");
    await rule().getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByLabel("在服务器使用的端口", { exact: true }).fill("7826");
    await page.getByRole("button", { name: "仅保存配置", exact: true }).click();
    assert(await address() === "127.0.0.1:7824", "reconnect silently changed endpoint");
    assert(await rule().getAttribute("data-phase") === "reconnecting", "save canceled reconnection");
  });
  await check("单条开启不改变其他规则或其待应用更改", async () => {
    await scenario("running");
    await page.getByRole("button", { name: "新增转发", exact: true }).click();
    await page.getByRole("button", { name: /在本机访问服务器服务/ }).click();
    await page.getByLabel("服务器上的服务端口", { exact: true }).fill("3000");
    await page.getByRole("button", { name: "仅保存配置", exact: true }).click();
    await rule().getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByLabel("在服务器使用的端口", { exact: true }).fill("7825");
    await page.getByRole("button", { name: "仅保存配置", exact: true }).click();
    await page.locator(".fp-rule").nth(1).getByRole("button", { name: "开启转发", exact: true }).click();
    await page.locator('.fp-rule[data-phase="running"]').nth(1).waitFor();
    assert(await rule().locator(".fp-rule-pending").count() === 1, "other pending edit discarded");
    assert(await address() === "127.0.0.1:7824", "other endpoint changed");
    await page.getByRole("button", { name: "停止转发", exact: true }).click();
    await page.locator(".fp-rule").nth(1).getByRole("button", { name: "开启转发", exact: true }).click();
    await page.locator(".fp-rule").nth(1).locator("..").locator('.fp-rule[data-phase="running"]').waitFor();
    assert(await rule().getAttribute("data-phase") === "stopped", "single start restarted all rules");
  });
  await check("错误可解释并重试，固定使用地址保留", async () => {
    await scenario("error");
    assert(await rule().getByRole("button", { name: "复制使用地址" }).isDisabled(), "failed listener copies as live");
    await rule().getByRole("button", { name: "查看原因", exact: true }).click();
    assert((await rule().locator(".fp-error-detail").innerText()).includes("不能判断"), "cause asserted without evidence");
    await rule().getByRole("button", { name: "重试", exact: true }).click();
    await running();
    assert(await address() === "127.0.0.1:7824", "retry changed endpoint");
  });
  await check("无效端口就地提示，高级设置可键盘展开", async () => {
    await scenario("local");
    await page.getByLabel("服务器上的服务端口", { exact: true }).fill("0");
    await page.getByRole("button", { name: "保存并开启", exact: true }).click();
    assert(await page.getByLabel("服务器上的服务端口", { exact: true }).getAttribute("aria-invalid") === "true", "invalid port allowed");
    await page.locator("summary").focus(); await page.keyboard.press("Enter");
    assert(await page.getByLabel("服务地址", { exact: true }).isVisible(), "keyboard disclosure failed");
  });
  await check("四种启动方式收在底部，切换可见反馈", async () => {
    await scenario("running");
    assert(await page.locator(".fp-auto-options").count() === 0, "advanced startup always expanded");
    await page.getByRole("button", { name: "更改启动方式", exact: true }).click();
    assert(await page.getByRole("radio").count() === 4, "startup options missing");
    await page.getByRole("radio", { name: /随 CC Bridge 启动/ }).check();
    assert((await page.locator(".fp-auto-line").innerText()).includes("随 CC Bridge 启动"), "selected mode not reflected");
  });
  await check("复制失败不显示成功，删除有行内确认", async () => {
    await scenario("running");
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => { throw new Error("clipboard blocked"); };
      document.execCommand = () => false;
    });
    await rule().getByRole("button", { name: "复制使用地址" }).click();
    assert(!await rule().getByRole("button", { name: "已复制", exact: true }).count(), "copy falsely succeeded");
    assert((await page.locator(".fp-toast").innerText()).includes("复制未完成"), "copy failure hidden");
    await rule().getByLabel("删除这条转发", { exact: true }).click();
    assert(await page.locator(".fp-delete-confirm").count() === 1, "delete confirmation missing");
    await page.getByRole("button", { name: "删除规则", exact: true }).click();
    assert(await page.locator(".fp-rule").count() === 0, "rule not deleted");
  });
  await check("原图对照可查看且回到新设计保留状态", async () => {
    await scenario("running");
    await page.getByRole("button", { name: "原界面", exact: true }).click();
    assert(await page.locator(".fp-reference img").isVisible(), "reference missing");
    assert(await page.locator(".fp-reference img").evaluate(node => node.complete && node.naturalWidth > 0), "reference not loaded");
    await page.getByRole("button", { name: "新设计", exact: true }).click();
    assert(await address() === "127.0.0.1:7824", "view switch reset rules");
  });
  const shots = [
    ["01-日常使用.png", 1280, 840, "running", "light", "glass"],
    ["02-首次选择用途.png", 1280, 840, "first", "light", "glass"],
    ["03-添加本机访问.png", 1280, 840, "local", "light", "glass"],
    ["04-添加服务器访问.png", 1280, 840, "remote", "light", "glass"],
    ["05-待应用更改.png", 1280, 840, "changed", "light", "glass"],
    ["06-异常处理.png", 1280, 840, "error", "light", "glass"],
    ["07-深色主题.png", 1280, 840, "running", "dark", "glass"],
    ["08-经典风格.png", 1280, 840, "first", "light", "classic"],
    ["09-紧凑窗口.png", 560, 860, "first", "light", "glass"],
    ["10-紧凑表单.png", 560, 960, "local", "light", "glass"],
  ];
  for (const [file, width, height, scene, theme, style] of shots) {
    await page.setViewportSize({ width, height });
    await page.goto(base + "?capture=1&scenario=" + scene + "&theme=" + theme + "&style=" + style);
    await page.locator(".fp-page h1").waitFor();
    if (scene === "local") await page.getByLabel("服务器上的服务端口", { exact: true }).fill("3000");
    if (scene === "remote") { await page.getByLabel("本机上的服务端口", { exact: true }).fill("7823"); await page.getByRole("button", { name: /使用建议端口 7824/ }).click(); }
    const overflow = await page.evaluate(() => [...document.querySelectorAll(".fp-page, .fp-form, .fp-rule, .fp-review-bar, .fp-topbar")].filter(node => node.getClientRects().length && node.scrollWidth > node.clientWidth + 2).map(node => node.className));
    layouts.push({ file, width, height, overflow });
    await page.screenshot({ path: path.join(destination, file), animations: "disabled" });
  }
  const scaled = await browser.newContext({ viewport: { width: 1262, height: 783 }, deviceScaleFactor: 1.25 });
  const scaledPage = await scaled.newPage();
  await scaledPage.goto(base + "?capture=1");
  await scaledPage.locator(".fp-rule").waitFor();
  await scaledPage.screenshot({ path: path.join(destination, "preview.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto(base + "?capture=1");
  await page.getByRole("button", { name: "更改启动方式", exact: true }).click();
  await page.mouse.move(0, 0);
  await page.locator(".fp-auto-footer").screenshot({ path: path.join(destination, "11-启动方式展开.png"), animations: "disabled" });
  await check("离线 HTML 独立可用，无网络与真实配置操作", async () => {
    await page.setViewportSize({ width: 1280, height: 840 });
    const file = pathToFileURL(path.join(destination, "preview.html")).href;
    await page.goto(file);
    await page.locator(".fp-page h1").waitFor();
    await page.getByRole("button", { name: "新增转发", exact: true }).click();
    assert(await page.locator(".fp-purpose-option").count() === 2, "offline interaction unavailable");
  });
  const previous = visualOnly ? JSON.parse(fs.readFileSync(path.join(destination, "qa.json"), "utf8")) : null;
  const report = { results: previous?.results || results, errors, layouts };
  fs.writeFileSync(path.join(destination, "qa.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  process.exitCode = results.some(item => !item.passed) || errors.length || layouts.some(item => item.overflow.length) ? 1 : 0;
})().catch(async error => { console.error(error); if (browser) await browser.close(); process.exitCode = 1; });
