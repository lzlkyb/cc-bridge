/* global window, navigator, getComputedStyle */
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const { URLSearchParams } = require("node:url");
const destination = path.resolve(__dirname, "../../.impeccable/review/port-forward-production-2026-11-16");
const base = process.env.CCBRIDGE_FORWARD_PRODUCTION_URL || "http://127.0.0.1:1449/forward-preview.html";
const results = [], layouts = [], errors = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const confirm = process.argv.includes("--confirm");
let browser;

(async () => {
  fs.mkdirSync(destination, { recursive: true });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    window.forwardCopies = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.forwardCopies.push(value); } } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.stack || error.message));
  page.on("response", response => { if (response.status() >= 400) errors.push(response.status() + " " + response.url()); });
  const open = async (scene, options = {}) => {
    await page.goto(base + "?" + new URLSearchParams({ scene, ...options }));
    await page.locator(".terminal-forward-panel h1").waitFor();
    if (scene !== "readError") await page.locator(".fp-managed-row").waitFor();
  };
  const check = async (label, action) => { try { await action(); results.push({ label, passed: true }); } catch (error) { results.push({ label, passed: false, error: String(error) }); } };
  const address = () => page.locator(".fp-use-address code").first().innerText();
  const calls = () => page.evaluate(() => window.forwardProductionCheck.getCalls());
  const capture = async (name, scene, width, height, options = {}, action) => {
    await page.setViewportSize({ width, height }); await open(scene, options); if (action) await action();
    const geometry = await page.locator(".terminal-forward-panel").evaluate(element => {
      const input = element.querySelector("#fp-access-port"), actions = element.querySelector(".fp-form-actions");
      return { width: element.clientWidth, overflow: element.scrollWidth > element.clientWidth + 1, footer: element.querySelector(".fp-auto-footer").getBoundingClientRect().height, button: element.querySelector(".fp-auto-change").getBoundingClientRect().height, title: getComputedStyle(element.querySelector(".fp-auto-summary h2")).fontSize,
        inputCovered: !!input && getComputedStyle(actions).position === "sticky" && input.getBoundingClientRect().bottom > actions.getBoundingClientRect().top };
    });
    await page.screenshot({ path: path.join(destination, name + (confirm ? "-确认" : "") + ".png") });
    layouts.push({ name, viewportWidth: width, viewportHeight: height, ...geometry });
    assert(!geometry.overflow, name + " 存在横向溢出");
    assert(geometry.button >= 40 && geometry.title === "15px", name + " 启动方式入口过小");
    assert(!geometry.inputCovered, name + " 主操作遮住了端口输入");
  };
  await check("两个用途同等突出，两个必要端口默认联动", async () => {
    await open("empty"); assert(await page.locator(".fp-purpose-option").count() === 2, "缺少用途");
    await page.locator(".fp-purpose-option").first().click(); await page.locator("#fp-target-port").fill("3000");
    assert(await page.locator("#fp-access-port").inputValue() === "3000", "访问端口未建议");
    await page.getByRole("button", { name: "保存并开启", exact: true }).click();
    await page.locator('.fp-rule[data-phase="running"]').waitFor();
    await page.getByRole("button", { name: "复制使用地址", exact: true }).click();
    assert(await page.evaluate(() => window.forwardCopies.at(-1)) === "127.0.0.1:3000", "使用地址错误");
    assert((await calls()).some(call => call.command === "ssh_tunnel_start"), "开启没有经过正式入口");
  });
  await check("保存待应用维持旧地址，应用后监听新地址", async () => {
    await open("running"); await page.locator("#forward-rule-web").getByRole("button", { name: "编辑", exact: true }).click();
    await page.locator("#fp-access-port").fill("3001"); await page.getByRole("button", { name: "仅保存配置", exact: true }).click();
    assert(await address() === "127.0.0.1:3000", "保存导致地址提前变化");
    assert(!(await calls()).some(call => call.command === "ssh_tunnel_start"), "仅保存启动了转发");
    await page.locator(".fp-page-head").getByRole("button", { name: "应用更改", exact: true }).click(); await page.locator('#forward-rule-web[data-phase="running"]').waitFor();
    assert(await address() === "127.0.0.1:3001", "应用未更新实际地址");
  });
  await check("启动方式栏可发现且选择只保存偏好", async () => {
    await open("paused"); await page.getByRole("button", { name: "更改启动方式", exact: true }).click();
    await page.getByRole("radio", { name: /随 CC Bridge 启动/ }).check();
    await page.locator(".fp-auto-current strong").filter({ hasText: "随 CC Bridge 启动" }).waitFor();
    assert(!(await calls()).some(call => call.command === "ssh_tunnel_start" || call.command === "ssh_tunnel_stop"), "选择启动方式改变了运行状态");
    assert((await page.locator(".fp-managed-phase").innerText()) === "已暂停", "暂停隧道被恢复");
    const options = await page.locator(".fp-auto-options label").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    assert(options.length === 4 && options.every(height => height >= 82), "启动选项过小");
  });
  await check("保存失败显示原选择，并保留表单值", async () => {
    await open("empty"); await page.evaluate(() => window.forwardProductionCheck.failSave(true));
    await page.locator(".fp-purpose-option").nth(1).click(); await page.locator("#fp-target-port").fill("9000"); await page.getByRole("button", { name: "仅保存配置", exact: true }).click();
    await page.getByText("保存转发规则失败", { exact: false }).waitFor(); assert(await page.locator("#fp-target-port").inputValue() === "9000", "失败丢失输入");
    assert(!(await calls()).some(call => call.command === "ssh_tunnel_start"), "保存失败仍开启");
  });
  await check("分配端口使用真实结果，失败规则禁止复制", async () => {
    await open("allocated"); assert(await address() === "127.0.0.1:32123", "复制了配置中的 0 端口");
    await open("failed"); assert(await page.locator("#forward-rule-reverse").getByRole("button", { name: "复制使用地址" }).isDisabled(), "失败规则仍可复制");
    assert((await page.locator(".fp-page-phase").innerText()).includes("需处理"), "标题漏掉监听失败");
  });
  await check("读取失败有恢复入口，管理接入定位原卡", async () => {
    await open("readError"); assert(await page.getByRole("button", { name: "新增转发", exact: true }).isDisabled(), "归属未知仍可新增");
    await page.evaluate(() => window.forwardProductionCheck.recoverRead()); await page.getByRole("button", { name: "重新读取" }).click(); await page.locator(".fp-managed-row").waitFor();
    await page.getByRole("button", { name: "管理接入", exact: true }).click();
    assert((await calls()).some(call => call.command === "stable_connect_select"), "未选择原接入服务器");
  });
  const startupOpen = () => page.getByRole("button", { name: "更改启动方式", exact: true }).click();
  const newRemote = async () => { await page.locator(".fp-purpose-option").nth(1).click(); await page.locator("#fp-target-port").fill("7823"); await page.locator("#fp-access-port").fill("7824"); };
  await capture("01-首次添加-浅色", "empty", 1280, 840);
  await capture("02-已开启-浅色", "running", 1280, 900);
  await capture("03-启动方式展开", "running", 1280, 900, {}, startupOpen);
  await capture("04-服务器访问本机-表单", "empty", 1280, 840, {}, newRemote);
  await capture("05-已开启-深色", "running", 1280, 900, { theme: "dark" });
  await capture("06-经典-待应用", "pending", 1280, 900, { style: "classic" });
  await capture("07-小窗口-表单", "empty", 800, 700, {}, newRemote);
  await capture("08-窄窗口-启动方式", "empty", 430, 820, {}, startupOpen);
  await capture("09-部分监听失败", "failed", 1280, 900);
  await capture("10-自动重连", "reconnecting", 1280, 900);
  const report = { productionComponents: true, nativeBackend: "simulated; no real SSH/VPN connections", results, layouts, errors };
  fs.writeFileSync(path.join(destination, confirm ? "确认报告.json" : "验收报告.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.passed).length, layouts: layouts.length, errors, destination }));
  if (errors.length || results.some(result => !result.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); });
