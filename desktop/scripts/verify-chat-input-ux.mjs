/* global document, getComputedStyle, innerWidth, innerHeight */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'design/chat-workspace-2026-10-27/.qa/package.json'));
const { chromium } = require('playwright');
const out = path.join(root, '.impeccable/review/chat-ux-defects');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = { checks: [], screenshots: [], errors: [] };
const draft = p => p.locator('[data-cc-panel]:visible .cc-composer-draft');
const button = (p, name) => p.getByRole('button', { name, exact: true });
async function makePage({ width = 1280, height = 840, theme = 'light', material = 'glass', scene = 'normal' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'no-preference' });
  await context.route('**/*', route => /^https?:/.test(route.request().url()) && !route.request().url().startsWith('http://127.0.0.1:1437/') ? route.abort() : route.continue());
  const p = await context.newPage(); p.setDefaultTimeout(7000); p.setDefaultNavigationTimeout(45000);
  p.on('pageerror', e => report.errors.push(e.message));
  await p.goto(`http://127.0.0.1:1437/e2e/chat-workspace.html?theme=${theme}&material=${material}&scene=${scene}`);
  await draft(p).waitFor({ timeout: 45000 }); await p.waitForTimeout(220);
  return { p, context };
}
async function test(name, run, options) {
  if (process.env.CHAT_INPUT_VERIFY_FILTER && !name.includes(process.env.CHAT_INPUT_VERIFY_FILTER)) return;
  const { p, context } = await makePage(options);
  try { await run(p); report.checks.push({ name, passed: true }); console.log('PASS', name); }
  catch (e) { report.checks.push({ name, passed: false, error: e.message }); console.log('FAIL', name, e.message); await shot(p, 'failure'); }
  finally { await context.close(); }
}
async function shot(p, name) {
  await p.waitForTimeout(220);
  await p.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  report.screenshots.push(name);
}
try {
  for (const item of [
    { name: 'user-2550-focus', width: 2550, height: 1275 },
    { name: 'desktop-light-focus' }, { name: 'desktop-dark-focus', theme: 'dark' },
    { name: 'classic-light-focus', material: 'classic' }, { name: 'classic-dark-focus', material: 'classic', theme: 'dark' },
    { name: 'compact-700-focus', width: 700 }, { name: 'compact-560-focus', width: 560, height: 620 },
    { name: 'compact-390-focus', width: 390 },
  ]) await test(`${item.name} 单层焦点、统一材质、空输入高度`, async p => {
    await draft(p).focus();
    const shape = await draft(p).evaluate(e => {
      const s = getComputedStyle(e), r = e.getBoundingClientRect(), surface = getComputedStyle(e.closest('[data-cc-composer]'));
      return { height: r.height, radius: s.borderTopLeftRadius, outline: s.outlineStyle, bg: s.backgroundColor,
        surfaceOutline: surface.outlineStyle, surfaceWidth: surface.outlineWidth, overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight };
    });
    assert.ok(shape.height >= 76 && shape.height <= 80, `空输入高度 ${shape.height}`);
    assert.equal(shape.outline, 'none'); assert.equal(shape.bg, 'rgba(0, 0, 0, 0)');
    assert.ok(parseFloat(shape.radius) > 0); assert.equal(shape.surfaceOutline, 'solid'); assert.equal(shape.surfaceWidth, '2px'); assert.equal(shape.overflow, false);
    await shot(p, item.name);
    await button(p, '添加内容').focus();
    assert.equal(await button(p, '添加内容').evaluate(e => getComputedStyle(e).outlineStyle), 'solid');
    assert.equal(await p.locator('[data-cc-composer]').evaluate(e => getComputedStyle(e).outlineStyle), 'none');
  }, item);
  await test('输入随宽度增高和缩回，清空后恢复高度与阅读空间', async p => {
    await draft(p).fill('界面宽度变化时，这段草稿应重新折行。'.repeat(5));
    const before = await draft(p).evaluate(e => e.clientHeight);
    await p.setViewportSize({ width: 390, height: 840 }); await p.waitForTimeout(260);
    const after = await draft(p).evaluate(e => e.clientHeight);
    assert.ok(after > before, `${before} -> ${after}`);
    await shot(p, 'compact-390-long');
    await p.setViewportSize({ width: 1280, height: 840 }); await p.waitForTimeout(260);
    assert.ok(await draft(p).evaluate(e => e.clientHeight < 168));
    await draft(p).fill(''); assert.equal(await draft(p).evaluate(e => e.clientHeight), 76);
  });
  await test('点击发送后直接继续输入，停止后仍保留新草稿', async p => {
    await draft(p).fill('第一条消息'); await p.locator('[data-cc-send]').click();
    assert.equal(await draft(p).evaluate(e => document.activeElement === e), true);
    await p.keyboard.insertText('下一条草稿');
    assert.equal(await draft(p).inputValue(), '下一条草稿');
    await button(p, '停止本轮').click(); assert.equal(await draft(p).inputValue(), '下一条草稿');
  });
  await test('历史编辑的输入法保护、单层焦点与取消保留原文', async p => {
    await p.locator('[data-cc-stream]').evaluate(e => { e.scrollTop = 0; });
    await button(p, '编辑并新开会话').click();
    const editor = p.getByRole('textbox', { name: '编辑这条消息' });
    await editor.fill('正在输入中文');
    await editor.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
    await editor.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
    assert.equal(await editor.inputValue(), '正在输入中文');
    assert.equal(await editor.evaluate(e => getComputedStyle(e).outlineStyle), 'none');
    await shot(p, 'history-edit-focus');
    await editor.press('Escape'); assert.equal(await editor.count(), 0);
    assert.equal(await p.getByRole('heading', { name: '排查登录请求超时', exact: true }).count(), 1);
  });
  await test('历史搜索结果不与空态冲突，子菜单键盘操作不切会话', async p => {
    await p.getByRole('searchbox').fill('API');
    assert.equal(await p.getByText('没有匹配的会话', { exact: true }).count(), 0);
    const menu = button(p, '更多操作：梳理 API 错误处理'); await menu.focus(); await menu.press('Enter');
    await p.getByRole('menuitem', { name: '重命名' }).waitFor();
    assert.equal(await p.getByRole('heading', { name: '排查登录请求超时', exact: true }).count(), 1);
    await shot(p, 'history-search-menu'); await p.keyboard.press('Escape');
  });
  await test('短窗长草稿加展开队列，文件面板按空间滚动且键盘选择可见', async p => {
    await draft(p).fill('首条'); await p.locator('[data-cc-send]').click();
    for (let index = 0; index < 3; index++) { await draft(p).fill(`待发送 ${index}`); await p.locator('[data-cc-send]').click(); }
    await button(p, '停止本轮').click(); await button(p, '管理').click();
    await draft(p).fill('多行内容\n'.repeat(35)); await p.waitForTimeout(250);
    const bounds = await p.locator('[data-cc-send]').boundingBox(); assert.ok(bounds.y + bounds.height <= 600);
    await shot(p, 'compact-560-queue-long');
    await draft(p).fill('多行内容\n'.repeat(35) + '@'); await draft(p).press('End');
    const files = p.locator('[aria-label="引用文件或目录"]'); await files.waitFor();
    await files.getByRole('button', { name: /web-console/ }).click();
    await files.getByRole('button', { name: 'file-24.ts', exact: true }).waitFor();
    await draft(p).press('ArrowUp');
    await p.setViewportSize({ width: 560, height: 520 }); await p.waitForTimeout(220);
    const pane = await p.locator('[data-cc-panel]').boundingBox(), panel = await files.boundingBox(), field = await draft(p).boundingBox();
    assert.ok(panel.y >= pane.y + 10 && panel.y + panel.height < field.y, JSON.stringify({ pane, panel, field }));
    const scroll = await files.locator('.cc-completion-options').evaluate(e => ({ top: e.scrollTop, height: e.clientHeight, full: e.scrollHeight }));
    assert.ok(scroll.top > 0 && scroll.full > scroll.height, JSON.stringify(scroll));
    assert.equal(await draft(p).evaluate(e => document.activeElement === e), true);
    await shot(p, 'compact-560-mention');
    await draft(p).press('Enter'); assert.ok((await draft(p).inputValue()).includes('file-24.ts'));
    await draft(p).fill('/');
    const commands = p.locator('[aria-label="slash 命令"]');
    assert.ok(await commands.isVisible());
    const rect = await commands.boundingBox(); assert.ok(rect.y >= pane.y && rect.x >= pane.x && rect.x + rect.width <= 560);
    await shot(p, 'compact-560-command');
    await commands.getByRole('button', { name: /\/model/ }).click(); assert.equal(await draft(p).inputValue(), '/model ');
  }, { width: 560, height: 600, scene: 'files' });
  await test('窄窗会话搜索完整可见且保留键盘查找', async p => {
    await draft(p).focus(); await p.keyboard.press('Control+f');
    const search = p.getByRole('textbox', { name: '搜索当前会话' }); await search.fill('登录');
    const rect = await search.locator('..').boundingBox(), pane = await p.locator('[data-cc-panel]').boundingBox();
    assert.ok(rect.x >= pane.x + 10 && rect.x + rect.width <= pane.x + pane.width - 10, JSON.stringify({ rect, pane }));
    assert.ok((await search.boundingBox()).width >= 100); await search.press('Enter');
    await shot(p, 'compact-390-find'); await search.press('Escape'); assert.equal(await search.count(), 0);
  }, { width: 390 });
  await test('窄窗历史编辑按钮保持整行文字，快捷键提示自然换行', async p => {
    await p.locator('[data-cc-stream]').evaluate(e => { e.scrollTop = 0; });
    await button(p, '编辑并新开会话').click();
    const actions = p.locator('.cc-user-edit-actions'), rect = await actions.boundingBox();
    for (const name of ['新会话重跑', '取消']) {
      const control = button(p, name), bounds = await control.boundingBox();
      assert.ok(bounds.height >= 28 && bounds.height <= 32 && bounds.x + bounds.width <= rect.x + rect.width);
      assert.equal(await control.evaluate(e => getComputedStyle(e).whiteSpace), 'nowrap');
    }
    await shot(p, 'compact-390-edit'); await button(p, '取消').click();
    assert.equal(await p.getByRole('textbox', { name: '编辑这条消息' }).count(), 0);
  }, { width: 390 });
  await test('附件移除目标可点，删除后空消息不可发送', async p => {
    await p.locator('input[type=file]').setInputFiles({ name: 'example.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO/8AAAAASUVORK5CYII=', 'base64') });
    const remove = button(p, '移除这张图'); await remove.waitFor();
    const rect = await remove.boundingBox(); assert.ok(rect.width >= 24 && rect.height >= 24);
    await shot(p, 'attachment-controls'); await remove.click();
    // 移除后要等 React 提交两轮状态（items → hasImages）再断言，否则全量跑时会偶发红。
    await p.waitForFunction(() => document.querySelector('[data-cc-send]').disabled);
    assert.equal(await p.locator('[data-cc-send]').isDisabled(), true);
  });
  await test('矮窗长草稿加展开队列，发送/停止与底行不被挤出 pane', async p => {
    // 审批场景：会话停在「等批准」，running 不会自己结束，停止按钮一直在，比普通场景稳定。
    await draft(p).fill('排队第一条'); await p.locator('[data-cc-send]').click();
    for (let index = 0; index < 2; index++) { await draft(p).fill(`排队 ${index}`); await p.locator('[data-cc-send]').click(); }
    await draft(p).fill('多行内容\n'.repeat(35));
    const inside = async label => {
      const box = await p.evaluate(() => {
        const rect = selector => document.querySelector(selector)?.getBoundingClientRect() ?? null;
        const area = document.querySelector('.cc-composer-draft');
        return { send: rect('[data-cc-send]').bottom, stop: rect('.cc-composer-stop')?.bottom ?? null,
          footer: rect('.cc-composer-footer').bottom, pane: rect('[data-cc-panel]').bottom,
          draftHeight: area.clientHeight, draftScrollable: area.scrollHeight > area.clientHeight,
          overflowY: document.documentElement.scrollHeight > innerHeight };
      });
      assert.ok(box.send <= box.pane, `${label}：发送按钮越出 pane ${JSON.stringify(box)}`);
      assert.ok(box.footer <= box.pane, `${label}：底行越出 pane ${JSON.stringify(box)}`);
      assert.ok(box.stop === null || box.stop <= box.pane, `${label}：停止按钮越出 pane ${JSON.stringify(box)}`);
      assert.ok(box.draftHeight >= 76, `${label}：草稿被压到 76px 地板以下 ${box.draftHeight}`);
      assert.equal(box.overflowY, false, `${label}：整页出现纵向滚动`);
      return box;
    };
    // 600 是 tauri.conf.json 的最小窗高；560×520 比真实外壳（顶栏 52 + 内容区间距 32）更紧一档。
    await p.setViewportSize({ width: 560, height: 520 }); await p.waitForTimeout(280);
    const waiting = await inside('等批准');
    assert.ok(waiting.stop !== null, '等批准时应同时校验停止按钮');
    await button(p, '停止本轮').click(); await button(p, '管理').click(); await p.waitForTimeout(280);
    const queued = await inside('展开队列');
    assert.ok(queued.draftScrollable, '草稿收缩后应内部可滚');
    await shot(p, 'compact-560-short-draft');
  }, { width: 560, height: 600, scene: 'approval' });
} finally {
  await browser.close(); await writeFile(path.join(out, process.env.CHAT_INPUT_VERIFY_FILTER ? 'focused-report.json' : 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.checks.filter(c => c.passed).length, total: report.checks.length, errors: report.errors }));
  if (report.errors.length || report.checks.some(c => !c.passed)) process.exitCode = 1;
}
