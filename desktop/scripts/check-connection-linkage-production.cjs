/* global window, document, navigator, innerWidth */
const { chromium } = require(process.env.CC_BRIDGE_PLAYWRIGHT || "../../design/chat-workspace-2026-10-27/.qa/node_modules/playwright");
const fs = require("node:fs");
const path = require("node:path");
const destination = path.resolve(__dirname, "../../.impeccable/review/connection-linkage-production");
const base = "http://127.0.0.1:1437/quick-connect-preview.html?view=linkage";
const capture = !process.argv.includes("--functional-only");
let browser;

(async () => {
  fs.mkdirSync(destination, { recursive: true });
  browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    window.productionCopies = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.productionCopies.push(value); } } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.setDefaultNavigationTimeout(30000);
  const errors = [], checks = [], layouts = [];
  page.on("pageerror", error => errors.push(error.message));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const check = async (label, work) => {
    try { await work(); checks.push({ label, passed: true }); }
    catch (error) {
      checks.push({ label, passed: false, error: String(error) }); console.error(label, String(error));
      if (await page.getByRole("dialog", { name: "搜索命令", exact: true }).count()) await page.keyboard.press("Escape");
    }
  };
  const state = value => page.locator(`.connection-status-card[data-connection-state="${value}"]`).waitFor({ timeout: 15000 });
  const scenario = async (value, expected = value) => {
    await page.getByLabel("验收场景", { exact: true }).selectOption(value); await state(expected);
  };
  const address = () => page.locator(".connection-address-row code").innerText();
  const copied = () => page.evaluate(() => window.productionCopies.at(-1));
  const copyAddress = async () => {
    const count = await page.evaluate(() => window.productionCopies.length);
    await page.getByLabel("复制接入地址", { exact: true }).click();
    await page.waitForFunction(count => window.productionCopies.length > count, count);
    return copied();
  };
  const palette = async () => {
    await page.getByLabel("搜索（Ctrl+K）", { exact: true }).click();
    await page.getByRole("dialog", { name: "搜索命令", exact: true }).waitFor();
    return page.getByRole("dialog", { name: "搜索命令", exact: true });
  };
  const closePalette = async () => { await page.keyboard.press("Escape"); await page.getByRole("dialog", { name: "搜索命令", exact: true }).waitFor({ state: "detached" }); };
  const paletteCopy = async label => {
    const dialog = await palette();
    await dialog.getByPlaceholder("搜索页面或执行操作...").fill(label);
    const count = await page.evaluate(() => window.productionCopies.length);
    await dialog.getByRole("button", { name: label, exact: true }).first().click();
    await page.waitForFunction(count => window.productionCopies.length > count, count);
    await page.getByRole("dialog", { name: "搜索命令", exact: true }).waitFor({ state: "detached" });
    return copied();
  };
  const screenshot = async name => {
    if (capture) await page.screenshot({ path: path.join(destination, name) });
  };
  await page.goto(`${base}&scenario=waiting`, { waitUntil: "domcontentloaded" }); await state("waiting");

  await check("主卡、顶栏和接入摘要区分通道与客户端证据", async () => {
    const card = await page.locator(".connection-status-card").innerText();
    assert(card.includes("SSH 加密转发") && card.includes("等待 Claude Code"), "chain lacks independent client evidence");
    assert((await page.locator(".app-header .connection-topbar-status").innerText()).includes("接入待验证"), "header differs");
    assert(card.includes("本机全部接入 · 历史"), "history is not explicitly global");
    assert(await address() === "http://127.0.0.1:7823/mcp", "wrong fixed address");
  });
  await check("接入卡和命令面板复制同一固定地址与完整项目命令", async () => {
    const cardAddress = await copyAddress();
    assert(await paletteCopy("复制服务器固定接入地址") === cardAddress, "address copy differs");
    if (!await page.locator(".sc-advanced").evaluate(element => element.open)) await page.locator(".sc-advanced > summary").click();
    await page.locator(".connect-command-details > summary").click();
    const command = await page.locator(".connect-command-details code").innerText();
    const count = await page.evaluate(() => window.productionCopies.length);
    await page.locator(".connect-command-details").getByRole("button", { name: "复制命令", exact: true }).click();
    await page.waitForFunction(count => window.productionCopies.length > count, count);
    assert(await copied() === command, "displayed command differs from backend copy");
    assert(await paletteCopy("复制当前连接命令") === command, "palette command differs");
    assert(command.includes("--scope project") && command.includes("/home/ubuntu/projects/orders"), "scope or directory missing");
    assert((await page.locator(".connection-card-headline").innerText()).includes("等待 Claude Code"), "copy falsely verified client");
  });
  await check("所有异常与待配置状态在顶栏、主卡和原接入卡联动", async () => {
    const cases = [["setup", "setup", "待配置"], ["server", "setup", "待配置"], ["recovery", "recovery", "正在重连"],
      ["login", "login", "需要登录"], ["paused", "paused", "已暂停"], ["changed", "changed", "待应用"],
      ["direct", "waiting", "接入待验证"], ["ip-changed", "ip-changed", "地址待更新"]];
    for (const [value, expected, short] of cases) {
      await scenario(value, expected);
      assert((await page.locator(".app-header .connection-topbar-status").innerText()).includes(short), `${value}: header differs`);
      if (["setup", "server"].includes(value)) {
        assert(await page.getByLabel("复制接入地址", { exact: true }).count() === 0, `${value}: setup shows an address before configuration`);
        const dialog = await palette(); await dialog.getByPlaceholder("搜索页面或执行操作...").fill("复制当前连接命令");
        assert(await dialog.getByRole("button", { name: "复制当前连接命令", exact: true }).count() === 0, `${value}: direct command leaked into tunnel`);
        await closePalette();
      }
    }
  });
  await check("VPN 恢复保留固定地址和客户端待验证状态", async () => {
    await scenario("recovery"); const original = await address();
    await page.getByRole("button", { name: "模拟网络恢复", exact: true }).click(); await state("waiting");
    assert(await address() === original, "recovery changed MCP address");
    assert((await page.locator(".connection-card-headline").innerText()).includes("等待 Claude Code"), "recovery promoted client evidence");
    assert((await page.locator("body").innerText()).includes("IP 替换命令") === false, "tunnel asks for IP replacement");
  });
  await check("暂停隧道后停止和启动本机服务仍保留暂停", async () => {
    await scenario("paused");
    await page.locator(".app-header").getByRole("button", { name: "停止本机服务", exact: true }).click();
    assert(await page.locator(".connection-service-actions button").first().isDisabled(), "another service control remains active during pending action");
    await state("service-stopped");
    await page.locator(".app-header").getByRole("button", { name: "启动本机服务", exact: true }).click(); await state("paused");
    assert(await page.getByRole("button", { name: "恢复隧道", exact: true }).isVisible(), "service start resumed paused tunnel");
  });
  await check("IP 直连按原表单保存范围，快捷复制保留项目目录", async () => {
    await scenario("direct", "waiting");
    const command = await page.locator(".connect-main-code").innerText();
    assert(command.includes("--scope project") && command.includes("/home/ubuntu/projects/orders"), "direct project command is incomplete");
    assert(await paletteCopy("复制当前连接命令") === command, "direct command differs");
    await scenario("ip-changed"); const original = await page.locator("p.connection-previous-address").innerText();
    const update = await paletteCopy("复制 IP 替换命令");
    assert(update.includes("10.203.5.58") && update.includes("/home/ubuntu/projects/orders"), "update uses wrong IP or original directory");
    await state("ip-changed");
    assert((await page.locator("p.connection-previous-address").innerText()) === original, "copy acknowledged a remote update");
  });
  await check("顶栏和快捷面板定位原接入卡并移动键盘焦点", async () => {
    await scenario("waiting", "waiting");
    await page.locator(".app-header .connection-topbar-status").click();
    await page.waitForFunction(() => document.activeElement?.id === "connect-guide");
    const dialog = await palette(); await dialog.getByPlaceholder("搜索页面或执行操作...").fill("查看与检查当前接入");
    await dialog.getByPlaceholder("搜索页面或执行操作...").press("Enter");
    await page.waitForFunction(() => document.activeElement?.id === "connect-guide");
    await page.getByLabel("复制接入地址", { exact: true }).focus();
    assert(await page.getByLabel("复制接入地址", { exact: true }).evaluate(element => element === document.activeElement), "copy button cannot receive keyboard focus");
  });
  await check("项目级迁移到全局后固定地址和客户端证据保持一致", async () => {
    await scenario("waiting", "waiting"); const original = await address();
    await page.getByRole("button", { name: "更改范围", exact: true }).click();
    await page.getByRole("group", { name: "接入生效范围", exact: true }).getByRole("button", { name: "所有项目都可用" }).click();
    await page.getByRole("button", { name: "核对接入配置", exact: true }).click();
    await page.getByRole("button", { name: "应用范围更改", exact: true }).click(); await state("applying"); await state("waiting");
    await page.getByRole("button", { name: "稍后验证", exact: true }).click();
    assert((await page.locator(".tunnel-flow-scope").innerText()).includes("所有项目可用"), "scope migration did not update summary");
    assert((await page.locator(".connection-card-target").innerText()).includes("全局模式"), "main card retains project scope");
    assert(await address() === original, "scope migration changed fixed endpoint");
    const command = await paletteCopy("复制当前连接命令");
    assert(command.includes("--scope user") && !command.startsWith("cd "), "global command retains project directory");
  });
  await check("令牌更新后全部入口待应用，应用完成后原提示收起", async () => {
    await scenario("waiting", "waiting"); const original = await address();
    if (!await page.locator(".sc-advanced").evaluate(element => element.open)) await page.locator(".sc-advanced > summary").click();
    await page.getByRole("button", { name: "重生成", exact: true }).click(); await page.getByRole("button", { name: "确定", exact: true }).click(); await state("changed");
    assert((await page.locator(".app-header .connection-topbar-status").innerText()).includes("待应用"), "header misses token update");
    await page.getByRole("button", { name: "核对并更新配置", exact: true }).click();
    assert(await page.getByRole("list", { name: "隧道接入步骤", exact: true }).count() === 0, "repair opened first-time setup");
    await page.getByRole("button", { name: "更新现有接入", exact: true }).click(); await state("applying"); await state("waiting");
    await page.getByRole("button", { name: "稍后验证", exact: true }).click();
    assert(await address() === original, "token update changed fixed endpoint");
    if (!await page.locator(".sc-advanced").evaluate(element => element.open)) await page.locator(".sc-advanced > summary").click();
    assert(!(await page.locator(".connect-token").innerText()).includes("原接入的 Token 待同步"), "token pending notice survives successful apply");
  });

  await check("窄窗口首次接入依次检查服务器、选择目标、确认配置和验证", async () => {
    await page.setViewportSize({ width: 390, height: 850 });
    await scenario("setup");
    await page.locator(".tunnel-flow").scrollIntoViewIfNeeded();
    await page.locator(".tunnel-flow-steps [aria-current=step]").filter({ hasText: "服务器" }).waitFor();
    assert(await page.locator(".tunnel-flow").evaluate(element => element.scrollWidth <= element.clientWidth + 1), "stepper overflows");
    await page.goto(`${base}&scenario=setup`, { waitUntil: "domcontentloaded" }); await state("setup");
    await page.locator(".tunnel-flow").scrollIntoViewIfNeeded();
    await screenshot("正式组件-390-首次接入.png");
    await page.getByRole("button", { name: "检查此服务器", exact: true }).click();
    await page.getByRole("button", { name: "所有项目都可用" }).click();
    await page.getByRole("button", { name: "核对接入配置", exact: true }).click();
    await page.locator(".tunnel-flow-steps [aria-current=step]").filter({ hasText: "应用配置" }).waitFor();
    await page.getByRole("button", { name: "创建隧道接入", exact: true }).click();
    await page.getByRole("heading", { name: "在 Claude Code 中验证", exact: true }).waitFor();
    assert((await address()).includes("127.0.0.1"), "verification shows a direct address");
  });

  for (const [width, theme, style] of [[1440, "light", "glass"], [1280, "light", "glass"], [800, "light", "glass"], [390, "light", "glass"], [1440, "dark", "glass"], [1440, "light", "classic"]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}&scenario=waiting&theme=${theme}&style=${style}`, { waitUntil: "domcontentloaded" }); await state("waiting");
    const layout = await page.evaluate(() => {
      const header = document.querySelector(".app-header");
      const guide = document.querySelector("#connect-guide");
      const row = document.querySelector(".connection-address-row");
      const rect = guide.getBoundingClientRect();
      return { pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
        headerWidth: header.clientWidth, headerScroll: header.scrollWidth,
        guideWidth: guide.clientWidth, guideScroll: guide.scrollWidth,
        addressWidth: row.clientWidth, addressScroll: row.scrollWidth,
        guideLeft: rect.left, guideRight: rect.right };
    });
    layouts.push({ width, theme, style, ...layout });
    await check(`${width}px ${theme}/${style} 正式界面无顶栏和接入卡溢出`, async () => {
      assert(layout.pageWidth <= layout.viewportWidth + 1, "page overflows");
      assert(layout.headerScroll <= layout.headerWidth + 1, "header overflows");
      assert(layout.guideScroll <= layout.guideWidth + 1 && layout.addressScroll <= layout.addressWidth + 1, "access card overflows");
      assert(layout.guideLeft >= -1 && layout.guideRight <= width + 1, "access card leaves viewport");
    });
    await screenshot(`正式组件-${width}-${theme}-${style}-看板.png`);
    await page.getByRole("button", { name: "定位接入卡", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === "connect-guide");
    await screenshot(`正式组件-${width}-${theme}-${style}-接入.png`);
  }
  const report = { passed: checks.every(item => item.passed) && errors.length === 0, checks, layouts, errors,
    boundary: "正式 React 组件；原生系统和 SSH 由隔离数据替代，未验证真实 VPN 或远端客户端。" };
  fs.writeFileSync(path.join(destination, "正式组件验收报告.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  if (!report.passed) process.exitCode = 1;
})().catch(async error => { console.error(error); await browser?.close(); process.exitCode = 1; });
