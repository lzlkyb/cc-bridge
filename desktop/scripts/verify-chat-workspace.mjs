import assert from 'node:assert/strict';
/* global document, getComputedStyle, requestAnimationFrame, CSS, innerWidth, innerHeight, URLSearchParams, setTimeout */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Reuse the isolated browser tooling installed for the approved prototype.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'design/chat-workspace-2026-10-27/.qa/package.json'));
const { chromium } = require('playwright');
const reducedMotion = process.env.CHAT_VERIFY_MOTION === 'reduce' ? 'reduce' : 'no-preference';
const out = path.resolve(root, process.env.CHAT_VERIFY_OUT || `.impeccable/review/chat-motion-${reducedMotion}`);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = { reducedMotion, checks: [], screenshots: [], runtimeErrors: [], externalRequests: [] };
const active = p => p.locator('[data-cc-panel]:visible');
const draft = p => active(p).getByRole('textbox', { name: '消息', exact: true });
const send = p => active(p).locator('[data-cc-send]');
const stream = p => active(p).locator('[data-cc-stream]');
const button = (p, name) => p.getByRole('button', { name, exact: true });
async function pageFor({ width = 1280, height = 840, scene = 'normal', theme = 'light', material = 'glass' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && !url.startsWith('http://127.0.0.1:1437/')) {
      report.externalRequests.push(url); return route.abort();
    }
    return route.continue();
  });
  const p = await context.newPage();
  p.setDefaultTimeout(7000);
  p.on('pageerror', error => report.runtimeErrors.push({ scene, error: error.message }));
  await p.goto(`http://127.0.0.1:1437/e2e/chat-workspace.html?${new URLSearchParams({ scene, theme, material })}`, { timeout: 45000 });
  await p.getByRole('heading', { name: '排查登录请求超时', exact: true }).waitFor({ timeout: 45000 });
  await draft(p).waitFor();
  await p.waitForTimeout(160);
  return { context, p };
}
async function test(name, run, options) {
  if (process.env.CHAT_VERIFY_FILTER && !name.includes(process.env.CHAT_VERIFY_FILTER)) return;
  let context;
  try {
    const entry = await pageFor(options); context = entry.context;
    await run(entry.p);
    report.checks.push({ name, passed: true }); console.log('PASS', name);
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.message }); console.log('FAIL', name, error.message.slice(0, 1200));
  } finally { await context?.close(); }
}
async function eventually(read, check, description) {
  const until = Date.now() + 6500;
  let value;
  do { value = await read(); if (check(value)) return; await new Promise(resolve => setTimeout(resolve, 90)); } while (Date.now() < until);
  assert.fail(`${description}: ${JSON.stringify(value)}`);
}
try {
  await test('有历史回复时新消息仍显示本轮等待，收到回复后消失', async p => {
    await draft(p).fill('检查发送状态'); await send(p).click();
    await active(p).getByRole('status').filter({ hasText: /等待响应|正在发送消息/ }).waitFor();
    await p.getByText(/收到：检查发送状态/).waitFor({ timeout: 8000 });
    assert.equal(await active(p).getByRole('status').filter({ hasText: /等待响应|正在发送消息/ }).count(), 0);
  });
  await test('窄窗专注审批展示真实差异，关闭保留草稿', async p => {
    await draft(p).fill('保留的审批草稿');
    await active(p).locator('[data-cc-approval] [data-cc-approval-focus]').click();
    const dialog = p.getByRole('dialog', { name: '专注审阅审批' }); await dialog.waitFor();
    assert.match(await dialog.innerText(), /src\/api\/client\.ts/);
    assert.match(await dialog.innerText(), /修改超时重试前/);
    await p.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await draft(p).inputValue(), '保留的审批草稿');
  }, { width: 560, height: 600, scene: 'approval' });
  await test('完成轮次展示真实工具结果并定位原记录', async p => {
    const summary = active(p).locator('.cc-turn-results'); await summary.waitFor();
    assert.match(await summary.innerText(), /本轮操作 · 2 项/);
    await summary.locator('summary').click();
    assert.match(await summary.innerText(), /api\/client\.ts/);
    assert.equal(await summary.getByRole('button', { name: /文件操作/ }).getAttribute('title'), 'src/api/client.ts');
    assert.match(await summary.innerText(), /npm run test/);
    assert.doesNotMatch(await summary.innerText(), /测试通过/);
    await summary.getByRole('button', { name: /文件操作/ }).click();
    assert.equal(await active(p).locator('[data-cc-tool="edit-result"]').isVisible(), true);
  }, { scene: 'results' });
  await test('设计升级：停止后发送且旧队列保持暂停', async p => {
    await draft(p).fill('启动当前任务'); await send(p).click();
    await draft(p).fill('旧队列消息'); await send(p).click();
    await active(p).locator('.cc-composer-queue').waitFor();
    await button(p, '选择发送方式').click();
    await p.getByRole('button', { name: /停止后发送.*确认停止/ }).click();
    await draft(p).fill('停止后优先消息'); await send(p).click();
    await p.getByText(/收到：停止后优先消息/).waitFor({ timeout: 9000 });
    assert.match(await active(p).locator('.cc-composer-queue').innerText(), /队列已暂停/);
    assert.match(await active(p).locator('.cc-composer-queue').innerText(), /旧队列消息/);
  }, { scene: 'approval' });
  await test('设计升级：问题目录跳转和返回阅读位置', async p => {
    await button(p, '问题目录').click();
    const panel = p.getByRole('dialog', { name: '问题目录', exact: true });
    await panel.getByRole('button').filter({ hasText: /1\./ }).click();
    await button(p, '回到刚才阅读处').click();
    assert.equal(await button(p, '回到刚才阅读处').count(), 0);
  });
  await test('设计升级：上下文引用移除保留其他草稿', async p => {
    await draft(p).fill('保留草稿 @src/api/request.ts');
    await p.getByRole('button', { name: /上下文清单/ }).click();
    const panel = p.getByRole('dialog', { name: '上下文清单', exact: true });
    assert.match(await panel.innerText(), /不代表文件已被读取/);
    await panel.getByRole('button', { name: '移除', exact: true }).click();
    assert.equal(await draft(p).inputValue(), '保留草稿 ');
    await p.keyboard.press('Escape');
  });
  await test('设计升级：真实命令输出追加草稿', async p => {
    await draft(p).fill('保留现有草稿');
    const summary = active(p).locator('.cc-turn-results'); await summary.locator('summary').click();
    await summary.getByRole('button', { name: /执行命令/ }).click();
    await active(p).getByRole('button', { name: '带入对话继续分析', exact: true }).click();
    const value = await draft(p).inputValue(); assert.match(value, /^保留现有草稿/); assert.match(value, /npm run test/);
  }, { scene: 'results' });
  await test('会话搜索常驻，切换会话保留独立草稿', async p => {
    await draft(p).fill('登录会话未发送的草稿');
    await button(p, '新对话').click();
    await draft(p).fill('新会话的另一份草稿');
    await p.locator('[data-cc-session-side] [role=button]').filter({ hasText: '排查登录请求超时' }).click();
    assert.equal(await draft(p).inputValue(), '登录会话未发送的草稿');
    const search = p.getByRole('searchbox'); await search.fill('API');
    assert.equal(await p.locator('[data-cc-session-side] [role=button]:visible').filter({ hasText: '排查登录请求超时' }).count(), 0);
    assert.ok(await p.getByText('梳理 API 错误处理', { exact: true }).isVisible());
  });
  await test('发送、排队、停止、编辑和明确恢复队列', async p => {
    await draft(p).fill('处理第一条'); await send(p).click();
    await draft(p).fill('等待处理的第二条'); await send(p).click();
    await button(p, '停止本轮').click();
    assert.match(await p.locator('.cc-composer-queue').innerText(), /队列已暂停/);
    await button(p, '管理').click();
    await button(p, '编辑第 1 条排队消息').click();
    await p.getByRole('dialog', { name: '编辑排队消息' }).getByRole('textbox').fill('修改后的第二条');
    await button(p, '保存').click();
    await draft(p).fill('第三条继续排队'); await send(p).click();
    assert.match(await p.locator('.cc-composer-queue').innerText(), /2 条/);
    assert.ok(!(await button(p, '停止本轮').count()));
    await button(p, '移除第 2 条排队消息').click();
    await button(p, '继续发送').click();
    await eventually(() => stream(p).innerText(), text => text.includes('收到：修改后的第二条'), '恢复后应发送编辑后的消息');
    assert.equal(await p.locator('.cc-composer-queue').count(), 0);
  });
  await test('中文输入法确认不发送；发送快捷键可切换', async p => {
    await draft(p).fill('中文输入中');
    await draft(p).dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    assert.equal(await draft(p).inputValue(), '中文输入中');
    await button(p, '设置发送快捷键').click();
    await p.getByRole('dialog').getByRole('button').filter({ hasText: 'Ctrl' }).click();
    await draft(p).press('Enter');
    assert.match(await draft(p).inputValue(), /中文输入中/);
    await draft(p).press('Control+Enter');
    await eventually(() => draft(p).inputValue(), value => value === '', 'Ctrl+Enter 应发送');
  });
  await test('阅读设置、模型菜单保留旧回复模型', async p => {
    await button(p, '阅读选项').click();
    await button(p, '大字').click();
    await p.keyboard.press('Escape');
    assert.equal(await button(p, '阅读选项').evaluate(e => e === document.activeElement), true);
    await button(p, '选择模型').click();
    await p.getByRole('dialog').getByRole('button').filter({ hasText: 'Sonnet' }).first().click();
    assert.match(await button(p, '选择模型').innerText(), /sonnet/i);
    assert.equal(await p.locator('.cc-assistant-heading small').first().innerText(), 'opus');
  });
  await test('搜索展开折叠工具，关闭后回到输入框', async p => {
    assert.equal(await p.locator('.cc-execution-summary').getAttribute('open'), null);
    await button(p, '搜索当前对话').click();
    await p.locator('[data-cc-panel]:visible input').filter({ visible: true }).last().fill('src/api/client.ts');
    await eventually(() => p.locator('.cc-execution-summary').getAttribute('open'), value => value !== null, '搜索应展开执行过程');
    await p.keyboard.press('Escape');
    assert.equal(await draft(p).evaluate(e => e === document.activeElement), true);
  });
  await test('更多菜单进入历史后 Escape 返回原按钮', async p => {
    await button(p, '更多会话操作').click();
    await p.getByRole('button', { name: /从本机历史打开/ }).click();
    await p.getByRole('dialog').waitFor();
    await p.keyboard.press('Escape');
    assert.equal(await button(p, '更多会话操作').evaluate(e => e === document.activeElement), true);
  });
  await test('连接失败可查看诊断，重试成功保留草稿', async p => {
    await draft(p).fill('网络恢复后继续的草稿');
    await p.locator('.cc-connection-issue summary').click();
    assert.match(await p.locator('.cc-connection-issue pre').innerText(), /Permission denied/);
    await button(p, '重新检查环境').click();
    await eventually(() => p.locator('.cc-connection-issue').count(), value => value === 0, '恢复后错误应消失');
    assert.equal(await draft(p).inputValue(), '网络恢复后继续的草稿');
  }, { scene: 'error' });
  await test('审批跳转定位并可作出裁决', async p => {
    const shortcut = button(p, '查看审批');
    if (await shortcut.isVisible()) await shortcut.click();
    else await active(p).locator('[data-cc-approval-focus]').click();
    const dialog = p.getByRole('dialog', { name: '专注审阅审批' }); await dialog.waitFor();
    await dialog.getByRole('button', { name: /允许一次/ }).click();
    await eventually(() => button(p, '查看审批').count(), value => value === 0, '已裁决审批应退出待办');
  }, { scene: 'approval', width: 560, height: 620 });
  await test('抽屉聚焦搜索，中文 Esc 不关闭，常规 Esc 归还焦点', async p => {
    await active(p).locator('[data-cc-sidebar-toggle]').click();
    const drawer = p.locator('[data-cc-sidebar-drawer]');
    assert.ok(await drawer.getByRole('searchbox').evaluate(e => e === document.activeElement));
    await drawer.getByRole('searchbox').dispatchEvent('keydown', { key: 'Escape', isComposing: true });
    assert.equal(await drawer.count(), 1);
    await p.keyboard.press('Escape');
    await eventually(() => active(p).locator('[data-cc-sidebar-toggle]').evaluate(e => e === document.activeElement), value => value, '关闭抽屉焦点应归还');
  }, { width: 700, height: 860 });
  await test('抽屉子菜单可编辑，关闭子菜单仍保留会话列表', async p => {
    await active(p).locator('[data-cc-sidebar-toggle]').click();
    await button(p, '更多操作：排查登录请求超时').click();
    await p.getByRole('menuitem', { name: '重命名' }).click();
    await p.getByRole('textbox', { name: '会话标题' }).fill('登录流程检查');
    await button(p, '保存').click();
    assert.equal(await p.locator('[data-cc-sidebar-drawer]').count(), 1);
    assert.ok(await p.getByRole('heading', { name: '登录流程检查' }).count());
    await p.keyboard.press('Escape');
  }, { width: 700, height: 860 });
  await test('图片可添加、移除，附件状态决定是否可发送', async p => {
    await active(p).locator('input[type=file]').setInputFiles({ name: 'example.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO/8AAAAASUVORK5CYII=', 'base64') });
    await eventually(() => send(p).isEnabled(), value => value, '图片处理后应允许发送');
    await button(p, '移除这张图').click();
    await eventually(() => send(p).isDisabled(), value => value, '移除唯一图片后发送应禁用');
  });
  for (const width of [560, 700]) await test(`窄窗 ${width} 输入工具完整、润色预览保留草稿`, async p => {
    await button(p, '添加内容').click();
    const menu = p.getByRole('dialog', { name: '添加内容' });
    assert.equal(await menu.getByRole('button', { name: '润色草稿' }).isDisabled(), true);
    await p.keyboard.press('Escape');
    assert.ok(await button(p, '添加内容').evaluate(e => e === document.activeElement));
    await draft(p).fill('先确认超时原因');
    await button(p, '添加内容').click();
    await menu.evaluate(e => Promise.all(e.getAnimations().map(animation => animation.finished)));
    assert.equal(await p.evaluate(() => document.documentElement.scrollHeight > innerHeight), false, '浮层不应撑高整页');
    await p.screenshot({ path: path.join(out, `compact-${width}-input-menu.png`), fullPage: true });
    await menu.getByRole('button', { name: '润色草稿' }).click();
    await button(p, '添加内容').click();
    assert.equal(await p.getByRole('dialog', { name: '添加内容' }).getByRole('button', { name: '正在润色草稿' }).isDisabled(), true);
    await p.keyboard.press('Escape');
    await p.getByRole('dialog', { name: '润色后的草稿' }).waitFor();
    assert.equal(await draft(p).inputValue(), '先确认超时原因');
    await button(p, '保留原稿').click();
    assert.equal(await draft(p).inputValue(), '先确认超时原因');
    await button(p, '添加内容').click();
    await p.getByRole('dialog', { name: '添加内容' }).getByRole('button', { name: '润色草稿' }).click();
    await button(p, '采用这版').click();
    assert.equal(await draft(p).inputValue(), '建议稿：先确认超时原因');
    await draft(p).fill('');
    await button(p, '添加内容').click();
    await p.getByRole('dialog', { name: '添加内容' }).getByRole('button', { name: '查看命令' }).click();
    await eventually(() => draft(p).inputValue(), value => value === '/', '命令入口应写入斜杠');
    assert.ok(await draft(p).evaluate(e => e === document.activeElement));
  }, { width, height: 820 });
  await test('长会话回看不会被新回复拉走', async p => {
    await draft(p).fill('继续梳理'); await send(p).click();
    await stream(p).evaluate(e => { e.scrollTop = 0; });
    await p.waitForTimeout(4400);
    assert.equal(await stream(p).evaluate(e => e.scrollTop), 0);
    assert.ok(await p.getByRole('button', { name: /回到底部/ }).isVisible());
  }, { scene: 'long' });
  await test('队列高度变化和回复完成时继续跟随底部', async p => {
    await draft(p).fill('底部阅读第一条'); await send(p).click();
    await draft(p).fill('底部阅读排队第二条'); await send(p).click();
    await button(p, '管理').click();
    await p.waitForTimeout(5000);
    const gap = await stream(p).evaluate(e => e.scrollHeight - e.scrollTop - e.clientHeight);
    assert.ok(gap < 55, `距离底部 ${gap}px`);
  });
  await test('动效：抽屉连续开合、退出隔离与偏好实时切换', async p => {
    await draft(p).fill('开合后保留的草稿');
    const slot = p.locator('.cc-sidebar-slot');
    const toggle = () => p.keyboard.press('Control+Shift+B');
    await toggle();
    await eventually(() => slot.getAttribute('data-entered'), value => value === 'true', '抽屉应进入');
    const frames = await slot.evaluate(async e => {
      const values = [];
      for (let frame = 0; frame < 8; frame++) {
        await new Promise(requestAnimationFrame);
        values.push(getComputedStyle(e).transform);
      }
      return values;
    });
    if (reducedMotion !== 'reduce') assert.ok(new Set(frames).size > 1, '正常模式应实际产生连续动画帧');
    await p.waitForTimeout(220);
    assert.equal(await p.locator('.cc-workspace-main').evaluate(e => e.inert), true);
    assert.ok(await slot.getByRole('searchbox').evaluate(e => e === document.activeElement));
    assert.equal(await slot.evaluate(e => getComputedStyle(e).transitionDuration), reducedMotion === 'reduce' ? '0s' : '0.18s');
    await p.screenshot({ path: path.join(out, 'compact-700-drawer.png'), fullPage: true });
    await toggle();
    assert.equal(await slot.evaluate(e => e.inert), true);
    assert.equal(await p.locator('.cc-workspace-main').evaluate(e => e.inert), false);
    await toggle();
    await p.waitForTimeout(260);
    assert.equal(await slot.isVisible(), true);
    assert.equal(await slot.evaluate(e => e.inert), false);
    await slot.getByRole('searchbox').fill('登录');
    await toggle();
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await eventually(() => slot.isVisible(), value => !value, '减少动态后立即结束离场');
    assert.equal(await p.locator('.cc-sidebar-shade').count(), 0);
    assert.equal(await draft(p).inputValue(), '开合后保留的草稿');
    await toggle();
    assert.equal(await slot.getByRole('searchbox').inputValue(), '登录');
    await p.keyboard.press('Escape');
    await p.setViewportSize({ width: 1280, height: 840 });
    await eventually(() => slot.evaluate(e => !e.inert && getComputedStyle(e).transform === 'none'), Boolean, '宽窗恢复侧栏不能残留位移或隔离');
  }, { width: 700, height: 860 });
  await test('动效：队列快速反转保留内容，收起后不留下交互节点', async p => {
    await draft(p).fill('首条'); await send(p).click();
    await draft(p).fill('保留的队列内容'); await send(p).click();
    await button(p, '停止本轮').click();
    await button(p, '管理').click();
    const reveal = p.locator('.cc-queue-reveal');
    await eventually(() => reveal.getAttribute('data-entered'), value => value === 'true', '队列应展开');
    await p.waitForTimeout(220);
    assert.ok((await reveal.boundingBox()).height > 30);
    await p.screenshot({ path: path.join(out, 'desktop-queue.png'), fullPage: true });
    await button(p, '收起').click();
    await button(p, '管理').click();
    await p.waitForTimeout(260);
    assert.match(await reveal.innerText(), /保留的队列内容/);
    await button(p, '收起').click();
    await eventually(() => reveal.count(), value => value === 0, '退出后清理队列节点');
    assert.match(await p.locator('.cc-composer-queue-peek').innerText(), /保留的队列内容/);
    assert.equal(await p.getByRole('button', { name: /编辑第.*排队消息/ }).count(), 0);
  });
  await test('动效：执行过程原生开合与搜索定位仍可见', async p => {
    const summary = p.locator('.cc-execution-summary');
    await summary.locator('summary').click();
    await p.waitForTimeout(230);
    assert.ok((await summary.boundingBox()).height > 60);
    await p.screenshot({ path: path.join(out, 'desktop-execution.png'), fullPage: true });
    await summary.locator('summary').press('Enter');
    await p.waitForTimeout(200);
    assert.equal(await summary.getAttribute('open'), null);
    assert.ok((await summary.boundingBox()).height < 60);
    assert.equal(await p.evaluate(() => CSS.supports('interpolate-size', 'allow-keywords')), true);
    await button(p, '搜索当前对话').click();
    await p.locator('[data-cc-panel]:visible input').filter({ visible: true }).last().fill('src/api/client.ts');
    await p.waitForTimeout(350);
    const mark = summary.locator('mark').first();
    assert.ok(await mark.isVisible());
    const rect = await mark.boundingBox(), view = await stream(p).boundingBox();
    assert.ok(rect && view && rect.y >= view.y && rect.y < view.y + view.height, '搜索结果应位于阅读视口');
    await p.keyboard.press('Escape');
  });
  const shots = [
    { name: 'desktop-light', width: 1280, height: 840 },
    { name: 'desktop-dark', width: 1280, height: 840, theme: 'dark' },
    { name: 'classic-light', width: 1280, height: 840, material: 'classic' },
    { name: 'classic-dark', width: 1280, height: 840, material: 'classic', theme: 'dark' },
    { name: 'wide', width: 1600, height: 960 },
    { name: 'user-1265', width: 1265, height: 785 },
    { name: 'compact-700', width: 700, height: 860 },
    { name: 'compact-560-approval', width: 560, height: 620, scene: 'approval' },
    { name: 'compact-560-error', width: 560, height: 620, scene: 'error' },
    { name: 'mobile-390-empty', width: 390, height: 844, scene: 'empty' },
  ];
  for (const shot of process.env.CHAT_VERIFY_FILTER ? [] : shots) {
    const { context, p } = await pageFor(shot);
    await p.waitForTimeout(300);
    const file = path.join(out, `${shot.name}.png`);
    await p.screenshot({ path: file, fullPage: true });
    const layout = await p.evaluate(() => {
      const area = document.querySelector('[data-cc-panel]:not(.hidden) .cc-composer-draft').getBoundingClientRect();
      const action = document.querySelector('[data-cc-panel]:not(.hidden) [data-cc-send]').getBoundingClientRect();
      const panel = getComputedStyle(document.querySelector('[data-cc-panel]:not(.hidden)'));
      const workspace = getComputedStyle(document.querySelector('.cc-workspace-root'));
      const backdrop = getComputedStyle(document.querySelector('.app-boot-fade'));
      return { overflow: document.documentElement.scrollWidth > innerWidth, composerInView: area.top >= 0 && action.bottom <= innerHeight, actionRight: action.right, viewport: innerWidth, panel: panel.backgroundImage, canvas: workspace.backgroundImage, backdrop: backdrop.backgroundImage };
    });
    report.screenshots.push({ ...shot, file, ...layout });
    console.log('SHOT', shot.name, JSON.stringify(layout));
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(path.join(out, process.env.CHAT_VERIFY_FILTER ? 'focused-report.json' : 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.checks.filter(c => c.passed).length, total: report.checks.length, runtimeErrors: report.runtimeErrors.length, externalRequests: report.externalRequests.length }));
  if (report.checks.some(c => !c.passed) || report.runtimeErrors.length || report.screenshots.some(s => s.overflow || !s.composerInView)) process.exitCode = 1;
}
