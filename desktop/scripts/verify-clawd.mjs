import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
/* global document, getComputedStyle, window */
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'design/chat-workspace-2026-10-27/.qa/package.json'));
const { chromium } = require('playwright');
const out = path.join(root, '.impeccable/review/clawd-production');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = { checks: [], runtimeErrors: [], screenshots: [] };
const emit = (p, event) => p.evaluate(e => window.ccClawdEvent(e), event);
const panel = p => p.locator('[data-cc-panel]:visible');
const pet = p => panel(p).locator('.cc-clawd-companion');
const status = p => panel(p).locator('.cc-clawd-label');
let index = 0;
async function test(name, fn, { width = 1280, height = 840, theme = 'light', material = 'classic', reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const p = await context.newPage(); p.setDefaultTimeout(7000);
  p.on('pageerror', e => report.runtimeErrors.push(e.message));
  try {
    await p.goto(`http://127.0.0.1:1437/e2e/chat-workspace.html?scene=clawd&theme=${theme}&material=${material}`, { timeout: 45000 });
    await status(p).waitFor();
    await fn(p);
    report.checks.push({ name, passed: true }); console.log('PASS', name);
  } catch (e) { report.checks.push({ name, passed: false, error: e.message }); console.log('FAIL', name, e.message.slice(0, 700)); }
  finally { await context.close(); }
}
async function start(p) {
  await emit(p, { kind: 'init', sessionId: 'clawd-run', model: 'opus', cwd: 'D:/projects/web-console' });
  await emit(p, { kind: 'userMessage', text: '检查超时处理与测试' });
}
async function tool(p, name = 'Read') {
  await start(p); const id = `clawd-tool-${++index}`;
  await emit(p, { kind: 'toolUse', toolUseId: id, name, input: { file_path: 'src/api/client.ts', command: 'npm test -- retry', old_string: 'retry: 3', new_string: 'retry: 0' } });
  return id;
}
async function screenshot(p, name) { await p.waitForTimeout(550); await p.screenshot({ path: path.join(out, name + '.png'), fullPage: true }); report.screenshots.push(name + '.png'); }
await test('圆润静态历史头像、真实完成结果与单个主角色', async p => {
  assert.equal(await panel(p).locator('.cc-assistant-heading .is-static').count(), 1);
  assert.equal(await pet(p).count(), 1); assert.equal(await status(p).innerText(), '本轮已完成');
  assert.equal(await pet(p).locator('svg').evaluate(el => getComputedStyle(el).shapeRendering), 'auto');
});
await test('读取与编辑：移动到真实工具旁，点击展开实际修改', async p => {
  const id = await tool(p, 'Edit'); await status(p).filter({ hasText: '正在编辑文件' }).waitFor();
  await p.waitForTimeout(650);
  assert.equal(await pet(p).getAttribute('data-landing'), 'task');
  const target = panel(p).locator('[data-cc-message]').filter({ has: p.locator(`[data-cc-tool="${id}"]`) });
  const a = await pet(p).boundingBox(), b = await target.boundingBox();
  assert.ok(Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y - 4) < 2);
  await pet(p).click(); await panel(p).getByText('retry: 0', { exact: false }).first().waitFor();
  await screenshot(p, 'classic-light-edit');
});
await test('审批角色定位真实请求，停止中不假装完成', async p => {
  await start(p);
  await emit(p, { kind: 'permissionAsk', requestId: 'clawd-approval', toolUseId: 'edit-approval', toolName: 'Edit', input: { file_path: 'src/api/client.ts', old_string: 'retry: 3', new_string: 'retry: 0' }, reason: '确认修改范围' });
  await status(p).filter({ hasText: '需要你批准' }).waitFor(); await p.waitForTimeout(550); await pet(p).click();
  assert.equal(await panel(p).locator('[data-cc-approval]').count(), 1);
  assert.equal(await panel(p).locator('[data-cc-approval-focus]').evaluate(el => el === document.activeElement), true);
  await screenshot(p, 'glass-dark-approval');
}, { theme: 'dark', material: 'glass' });
await test('真实Agent身份、成员独立状态、父任务与完成结果', async p => {
  await start(p);
  for (const task of [
    { taskId: 'explore', taskType: 'local_agent', name: 'Explore', description: '分析登录', status: 'running', lastToolName: 'Read' },
    { taskId: 'implement', taskType: 'local_agent', name: 'Implement', parentTaskId: 'explore', status: 'running', lastToolName: 'Edit' },
    { taskId: 'cmd', taskType: 'local_bash', status: 'running' },
  ]) await emit(p, { kind: 'taskUpdate', task });
  await panel(p).getByRole('complementary', { name: '协作小队', exact: true }).waitFor();
  assert.equal(await panel(p).locator('.cc-clawd-agent').count(), 2);
  assert.equal(await panel(p).locator('.cc-clawd-agent [data-act=reading]').count(), 1);
  assert.equal(await panel(p).locator('.cc-clawd-agent [data-act=editing]').count(), 1);
  await panel(p).locator('.cc-clawd-agent').nth(1).click();
  assert.match(await panel(p).getByRole('region', { name: 'Agent 任务详情' }).innerText(), /父任务：分析登录/);
  await emit(p, { kind: 'taskUpdate', task: { taskId: 'explore', status: 'completed', summary: '已检查登录流程' } });
  await screenshot(p, 'classic-dark-agents');
}, { theme: 'dark' });
await test('后台任务数量不虚构Agent；重试收到进展后恢复', async p => {
  await emit(p, { kind: 'backgroundTasks', pending: 2 }); assert.equal(await status(p).innerText(), '后台任务仍在运行');
  assert.equal(await panel(p).getByRole('button', { name: /展开小队/ }).count(), 0);
  await start(p); await emit(p, { kind: 'retry', attempt: 2, max: 3, message: '等待连接恢复' });
  await status(p).filter({ hasText: '正在重试 2/3' }).waitFor();
  await emit(p, { kind: 'thinking', blockId: 'recovered', text: '继续检查', streaming: true });
  assert.equal(await status(p).innerText(), '正在分析');
});
await test('减少动作、输入安静状态与角色定位保留', async p => {
  await tool(p); await panel(p).getByLabel("Clawd 动态设置").click(); await panel(p).getByRole('button', { name: '减少 Clawd 动态效果' }).click();
  assert.equal(await pet(p).locator('.body').evaluate(el => getComputedStyle(el).animationName), 'none');
  await panel(p).getByRole('textbox', { name: '消息', exact: true }).focus();
  assert.equal(await panel(p).locator('[data-clawd-typing=true]').count(), 1);
}, { width: 700 });
await test('系统减少动作在进入页面前即生效', async p => {
  await tool(p); assert.equal(await pet(p).locator('.body').evaluate(el => getComputedStyle(el).animationName), 'none');
}, { reducedMotion: 'reduce' });
for (const width of [560, 390]) await test(`窄窗口${width}审批布局与角色不盖住操作`, async p => {
  await start(p); await emit(p, { kind: 'permissionAsk', requestId: 'narrow', toolUseId: null, toolName: 'Bash', input: { command: 'npm test -- retry' }, reason: '验证修改' });
  await p.waitForTimeout(650);
  const overflow = await panel(p).evaluate(el => el.scrollWidth > el.clientWidth + 2);
  assert.equal(overflow, false);
  const a = await pet(p).boundingBox();
  const overlap = await panel(p).locator('[data-cc-approval] button').evaluateAll((els, rect) => els.filter(el => { const b = el.getBoundingClientRect(); return b.width && b.left < rect.x + rect.width && b.right > rect.x && b.top < rect.y + rect.height && b.bottom > rect.y; }).length, a);
  assert.equal(overlap, 0);
  await screenshot(p, `compact-${width}-approval`);
}, { width, height: 700, theme: 'dark', material: 'glass' });
await browser.close(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.runtimeErrors.length || report.checks.some(c => !c.passed)) process.exitCode = 1;
