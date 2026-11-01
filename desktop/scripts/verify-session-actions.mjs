import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
/* global window */
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'design/chat-workspace-2026-10-27/.qa/package.json'));
const { chromium } = require('playwright');
const out = path.join(root, '.impeccable/review/session-actions'); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = { checks: [], errors: [] };
const side = p => p.locator('[data-cc-session-side]:visible');
const row = (p, title) => side(p).locator('[role=button]').filter({ hasText: title });
const active = p => p.locator('[data-cc-panel]:visible');
async function menu(p, title) { await side(p).getByRole('button', { name: `更多操作：${title}`, exact: true }).click(); }
async function test(name, fn, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 840 } }); const p = await context.newPage(); p.setDefaultTimeout(7000); p.on('pageerror', e => report.errors.push(e.message));
  try { await p.goto('http://127.0.0.1:1437/e2e/chat-workspace.html?scene=sessions', { timeout: 45000 }); await active(p).getByRole('heading', { name: '排查登录请求超时', exact: true }).waitFor(); if (width < 900) await active(p).getByRole('button', { name: '展开会话列表' }).click(); await fn(p); report.checks.push({ name, passed: true }); console.log('PASS', name); }
  catch (e) { report.checks.push({ name, passed: false, error: e.message }); console.log('FAIL', name, e.message.slice(0, 800)); await p.screenshot({ path: path.join(out, 'failure-' + report.checks.length + '.png') }); }
  finally { await context.close(); }
}
await test('归档当前页后移到已归档，打开不重复，取消归档立即回最近', async p => {
  await menu(p, '排查登录请求超时'); await p.getByRole('menuitem', { name: '归档', exact: true }).click();
  await row(p, '排查登录请求超时').waitFor({ state: 'hidden' });
  await side(p).getByRole('button', { name: /^已归档/ }).click(); await row(p, '排查登录请求超时').waitFor(); assert.equal(await row(p, '排查登录请求超时').count(), 1);
  const count = await p.locator('[data-cc-panel]').count(); await row(p, '排查登录请求超时').click();
  await active(p).getByRole('heading', { name: '排查登录请求超时' }).waitFor(); assert.equal(await p.locator('[data-cc-panel]').count(), count);
  await menu(p, '排查登录请求超时'); await p.getByRole('menuitem', { name: '取消归档', exact: true }).click();
  await side(p).getByRole('button', { name: '最近', exact: true }).getAttribute('aria-pressed').then(v => assert.equal(v, 'true'));
  assert.equal(await row(p, '排查登录请求超时').count(), 1);
  await menu(p, '排查登录请求超时'); await p.getByRole('menuitem', { name: '归档', exact: true }).waitFor();
});
await test('删除前可取消；删除最后一条后保留空白页且不再出现记录', async p => {
  await menu(p, '排查登录请求超时'); await p.getByRole('menuitem', { name: '删除会话…' }).click();
  assert.equal(await p.evaluate(() => window.ccSessionTest.deleted()), 0);
  await p.screenshot({ path: path.join(out, 'delete-confirmation.png'), fullPage: true });
  await p.getByRole('dialog', { name: '确认删除会话' }).getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await row(p, '排查登录请求超时').count(), 1);
  await p.getByRole('menuitem', { name: '删除会话…' }).click(); await p.getByRole('button', { name: '确认删除', exact: true }).click();
  await row(p, '排查登录请求超时').waitFor({ state: 'hidden' });
  assert.equal(await active(p).count(), 1); assert.equal(await p.evaluate(() => window.ccSessionTest.deleted()), 1);
  assert.ok(!(await p.evaluate(() => window.ccSessionTest.rows())).some(r => r.rowId === 1));
});
await test('归档请求在途切换范围，替代页面仍会出现在最近', async p => {
  await p.evaluate(() => window.ccSessionTest.holdArchive());
  await menu(p, '排查登录请求超时'); await p.getByRole('menuitem', { name: '归档', exact: true }).click();
  await side(p).getByRole('button', { name: /^已归档/ }).click();
  await p.evaluate(() => window.ccSessionTest.releaseArchive());
  await active(p).getByRole('heading', { name: '新对话', exact: true }).waitFor();
  assert.equal(await side(p).getByRole('button', { name: '最近', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await row(p, '新对话').count(), 1);
});
await test('删除失败保留目标并显示错误，重试可完成', async p => {
  await p.evaluate(() => window.ccSessionTest.failDelete());
  await menu(p, '排查登录请求超时'); await p.getByRole('menuitem', { name: '删除会话…' }).click(); await p.getByRole('button', { name: '确认删除', exact: true }).click();
  await p.getByRole('alert').filter({ hasText: '数据库暂时不可用' }).waitFor(); assert.equal(await row(p, '排查登录请求超时').count(), 1);
  await p.getByRole('button', { name: '确认删除', exact: true }).click(); await row(p, '排查登录请求超时').waitFor({ state: 'hidden' });
});
await test('历史与已归档记录也有删除入口，抽屉内确认可操作', async p => {
  await menu(p, '梳理 API 错误处理'); await p.getByRole('menuitem', { name: '归档', exact: true }).click();
  await side(p).getByRole('button', { name: /^已归档/ }).click(); await menu(p, '梳理 API 错误处理');
  await p.getByRole('menuitem', { name: '删除会话…' }).click(); await p.getByRole('button', { name: '确认删除', exact: true }).click();
  await row(p, '梳理 API 错误处理').waitFor({ state: 'hidden' });
  await p.screenshot({ path: path.join(out, 'compact-archived.png'), fullPage: true });
}, 560);
await test('新会话首次保存后立即可归档和删除，空白会话也能移除', async p => {
  await side(p).getByRole('button', { name: '新对话', exact: true }).click();
  await active(p).getByRole('textbox', { name: '消息', exact: true }).fill('首次保存即可管理'); await active(p).locator('[data-cc-send]').click();
  await row(p, '首次保存即可管理').waitFor(); await menu(p, '首次保存即可管理'); await p.getByRole('menuitem', { name: '归档', exact: true }).waitFor();
  await p.getByRole('menuitem', { name: '删除会话…' }).click(); await p.getByRole('button', { name: '确认删除', exact: true }).click(); await row(p, '首次保存即可管理').waitFor({ state: 'hidden' });
  await side(p).getByRole('button', { name: '新对话', exact: true }).click(); await menu(p, '新对话'); await p.getByRole('menuitem', { name: '删除会话…' }).click(); await p.getByRole('button', { name: '确认删除', exact: true }).click();
  assert.equal(await active(p).count(), 1);
});
await browser.close(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); if (report.errors.length || report.checks.some(c => !c.passed)) process.exitCode = 1;
