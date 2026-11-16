/* global window, navigator, document, innerWidth */
const { chromium } = require("../../design/chat-workspace-2026-10-27/.qa/node_modules/playwright");
const path = require("node:path");
const fs = require("node:fs");
const destination = path.resolve(__dirname, "../../.impeccable/review/connection-linkage");
const base = "http://127.0.0.1:1436/quick-connect-preview.html?view=linkage&scenario=verified";
const captureScreens = !process.argv.includes("--functional-only");
let browser;

(async () => {
  fs.mkdirSync(destination, { recursive: true });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => {
    window.previewCopies = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.previewCopies.push(value); } } });
  });
  const page = await context.newPage();
  const errors = [];
  const results = [];
  const layouts = [];
  page.on("pageerror", error => errors.push(error.message));
  const check = async (label, test) => {
    try { await test(); results.push({ label, passed: true }); }
    catch (error) { results.push({ label, passed: false, error: String(error) }); }
  };
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const state = async value => page.locator(`.ll-status-card[data-linkage-status="${value}"]`).waitFor({ timeout: 12000 });
  const scenario = async (value, expected) => { await page.getByLabel("演示场景", { exact: true }).selectOption(value); await state(expected); };
  const copyValue = () => page.evaluate(() => window.previewCopies.at(-1));
  const closePalette = async () => { await page.getByLabel("关闭命令面板").click(); await page.getByRole("dialog", { name: "命令面板" }).waitFor({ state: "detached" }); };
  const screenshot = async name => {
    if (!captureScreens) return;
    await page.waitForFunction(() => !document.querySelector(".toast"), null, { timeout: 6500 }).catch(() => {});
    await page.screenshot({ path: path.join(destination, name) });
  };
  await page.goto(base);
  await state("verified");
  await screenshot("01-隧道接入已核实.png");

  await check("主卡、顶栏和常驻地址使用当前隧道", async () => {
    expect(await page.locator(".ll-topbar-status").innerText().then(text => text.includes("接入已核实")), "topbar differs");
    expect(await page.locator(".ll-chain").innerText().then(text => text.includes("隧道通道") && !text.includes("防火墙")), "chain differs");
    expect(await page.locator(".ll-address-row code").innerText() === "http://127.0.0.1:7823/mcp", "wrong address");
  });
  await check("页面、托盘和命令面板复制地址一致", async () => {
    await page.getByLabel("复制接入地址", { exact: true }).click(); const card = await copyValue();
    await page.getByRole("button", { name: "托盘预览", exact: true }).click();
    await page.getByRole("dialog", { name: "托盘菜单预览" }).getByRole("button", { name: "复制接入地址", exact: true }).click(); const tray = await copyValue();
    if (captureScreens) await page.screenshot({ path: path.join(destination, "02-托盘同步入口.png") });
    await page.getByLabel("关闭托盘预览").click(); await page.getByLabel("搜索（Ctrl+K）").click();
    await page.getByRole("dialog", { name: "命令面板" }).getByRole("button", { name: "复制接入地址" }).click(); const palette = await copyValue();
    expect(card === tray && tray === palette, "copy values differ");
    expect(!await page.getByRole("dialog", { name: "命令面板" }).innerText().then(text => text.includes("IP 替换")), "tunnel offers IP replacement");
    if (captureScreens) await page.screenshot({ path: path.join(destination, "03-命令面板同步入口.png") }); await closePalette();
  });
  await check("历史调用不证明当前客户端接入", async () => {
    await scenario("waiting", "waiting");
    expect(await page.locator(".ll-history-summary").innerText().then(text => text.includes("146")), "history absent");
    expect(await page.locator(".ll-topbar-status").innerText().then(text => text.includes("待验证")), "history falsely verified target");
    await page.getByRole("button", { name: "模拟客户端调用", exact: true }).click(); await state("verified");
  });
  await check("未配置隧道的全局入口不回退为直连命令", async () => {
    await scenario("setup", "setup"); await page.getByLabel("搜索（Ctrl+K）").click();
    expect(await page.getByRole("dialog", { name: "命令面板" }).getByRole("button", { name: "复制接入命令" }).isDisabled(), "unconfigured command available");
    expect(await page.getByRole("dialog", { name: "命令面板" }).getByRole("button", { name: "复制接入地址" }).isDisabled(), "placeholder address available");
    await closePalette(); await screenshot("04-首次接入.png");
  });
  await check("VPN 恢复复用固定地址，各入口同步重连状态", async () => {
    await scenario("recovery", "recovery"); const address = await page.locator(".ll-address-row code").innerText();
    expect(!await page.locator(".connect-tab").innerText().then(text => text.includes("网络地址已变化")), "tunnel shows IP alert");
    expect(await page.locator(".app-side-status").innerText().then(text => text.includes("正在重连")), "sidebar differs");
    await screenshot("05-VPN重连.png");
    await page.getByRole("button", { name: "模拟网络恢复", exact: true }).click(); await state("waiting");
    expect(await page.locator(".ll-address-row code").innerText() === address, "address changed after recovery");
    await page.getByRole("button", { name: "模拟客户端调用", exact: true }).click(); await state("verified");
    await page.getByRole("group", { name: "连接方式" }).getByRole("button", { name: "IP 直连", exact: true }).click(); await state("setup");
    expect(await page.locator(".connect-tab").innerText().then(text => text.includes("网络地址已变化")), "tunnel verification cleared direct IP baseline");
  });
  await check("停止与启动本机服务保留用户暂停的隧道", async () => {
    await scenario("paused", "paused"); await page.locator(".ll-topbar").getByRole("button", { name: "停止服务", exact: true }).click(); await state("service-stopped");
    await page.locator(".ll-topbar").getByRole("button", { name: "启动服务", exact: true }).click(); await state("paused");
    expect(await page.locator(".ll-topbar-status").innerText().then(text => text.includes("已暂停")), "pause not preserved");
  });
  await check("Token 变更后原接入和所有快捷入口一致待更新", async () => {
    await scenario("changed", "changed"); await page.getByLabel("搜索（Ctrl+K）").click();
    expect(await page.getByRole("dialog", { name: "命令面板" }).getByRole("button", { name: "复制接入命令" }).isDisabled(), "dirty command available");
    await closePalette(); await screenshot("06-配置待更新.png");
  });
  await check("登录异常保留地址，服务器切换不继承旧验证", async () => {
    await scenario("login", "login"); expect(await page.locator(".ll-address-row code").innerText() === "http://127.0.0.1:7823/mcp", "login lost endpoint");
    await scenario("server", "setup"); expect(await page.locator(".ll-card-target").innerText().then(text => text.includes("开发服务器")), "old server retained");
  });
  await check("单纯切换方式显示待配置，不改变远端接入", async () => {
    await scenario("verified", "verified"); await page.getByRole("group", { name: "连接方式" }).getByRole("button", { name: "IP 直连", exact: true }).click();
    await state("setup"); expect(await page.locator(".ll-selection-note").innerText().then(text => text.includes("完成接入后")), "selection presented as applied");
  });
  await check("IP 直连保留原表单，复制保留项目目录", async () => {
    await scenario("direct", "verified");
    await page.getByRole("button", { name: "复制连接命令", exact: true }).click(); const command = await copyValue();
    expect(command.includes("/home/ubuntu/projects/orders") && command.includes("--scope project"), "project placement missing");
    await state("copied"); await page.getByLabel("搜索（Ctrl+K）").click();
    await page.getByRole("dialog", { name: "命令面板" }).getByRole("button", { name: "复制接入命令" }).click(); expect(await copyValue() === command, "palette command differs");
    await closePalette();
  });
  await check("IP 更新指向旧项目，只替换原接入地址", async () => {
    await scenario("ip-changed", "ip-changed"); await page.getByLabel("搜索（Ctrl+K）").click();
    await page.getByRole("dialog", { name: "命令面板" }).getByRole("button", { name: "复制 IP 替换命令" }).click(); const command = await copyValue();
    expect(command.includes("/home/ubuntu/projects/orders") && command.includes(".mcp.json") && command.includes("10.203.5.58"), "wrong update target");
    await closePalette(); await screenshot("07-IP地址更新.png");
  });

  for (const configuration of [
    { name: "08-浅色柔光窄窗", width: 800, height: 720, theme: "light", style: "glass" },
    { name: "09-深色柔光", width: 1440, height: 960, theme: "dark", style: "glass" },
    { name: "10-浅色经典", width: 1280, height: 900, theme: "light", style: "classic" },
    { name: "11-最窄窗口", width: 390, height: 844, theme: "light", style: "glass" },
  ]) {
    await page.setViewportSize({ width: configuration.width, height: configuration.height });
    await page.goto(`${base}&theme=${configuration.theme}&style=${configuration.style}`); await state("verified");
    const geometry = await page.evaluate(() => {
      const card = document.querySelector(".card-primary").getBoundingClientRect();
      const bar = document.querySelector(".ll-topbar").getBoundingClientRect();
      return { documentOverflow: document.documentElement.scrollWidth > innerWidth, cardOutside: card.right > innerWidth + 1, barOverflow: bar.width > innerWidth + 1 };
    });
    layouts.push({ ...configuration, ...geometry });
    if (captureScreens) await page.screenshot({ path: path.join(destination, `${configuration.name}.png`) });
  }
  const report = { results, layouts, errors };
  fs.writeFileSync(path.join(destination, "interaction-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  if (errors.length || results.some(result => !result.passed) || layouts.some(layout => layout.documentOverflow || layout.cardOutside || layout.barOverflow)) process.exitCode = 1;
})().catch(async error => { console.error(error); await browser?.close(); process.exitCode = 1; });
