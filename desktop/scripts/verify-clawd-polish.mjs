import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
/* global window, document */
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'design/chat-workspace-2026-10-27/.qa/package.json'));
const {chromium} = require('playwright');
const out = path.join(root, '.impeccable/review/clawd-polish');
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'msedge', headless: true});
const report = [];
try {
  for (const [width, height, theme, material] of [[1280,840,'light','classic'], [1280,840,'dark','classic'], [800,600,'dark','glass'], [560,700,'light','glass'], [390,700,'dark','glass']]) {
    const context = await browser.newContext({viewport: {width, height}});
    const p = await context.newPage(); const errors = [];
    p.on('pageerror', error => errors.push(error.message));
    try {
      for (const scene of ['normal', 'results', 'approval', 'clawd']) {
        await p.goto(`http://127.0.0.1:1437/e2e/chat-workspace.html?scene=${scene}&theme=${theme}&material=${material}`);
        const pane = p.locator('[data-cc-panel]:visible');
        const pet = pane.locator('.cc-clawd-companion');
        await pet.waitFor(); await p.waitForTimeout(400);
        assert.match(await pet.getAttribute('style'), /translate/);
        assert.equal(await pane.evaluate(el => el.scrollWidth > el.clientWidth + 2), false);
        if (scene !== 'clawd') continue;
        const before = await pane.locator('[data-cc-stream]').boundingBox();
        await p.evaluate(async () => { for (let i = 0; i < 5; i++) await window.ccClawdEvent({kind:'taskUpdate',task:{taskId:`polish-${i}`,taskType:'local_agent',description:`检查登录流程 ${i}`,status:'running',background:true}}); });
        await pane.getByRole('button', {name:'小队 · 5 项运行中', exact:true}).click();
        const inspector = pane.getByRole('complementary', {name:'小队详情'});
        await inspector.waitFor(); await pane.locator('.cc-clawd-agent').first().click();
        const after = await pane.locator('[data-cc-stream]').boundingBox();
        assert.ok(after.height >= before.height - 3, 'details must not shrink transcript');
        const box = await inspector.boundingBox();
        assert.ok(box.y >= after.y, 'details must stay inside reading area');
        assert.ok(box.y + box.height <= after.y + after.height + 5);
        await p.screenshot({path:path.join(out, `${width}-${theme}-${material}.png`)});
        await p.keyboard.press('Escape'); assert.equal(await inspector.count(),0);
        assert.equal(await pet.evaluate(el => el === document.activeElement),true);
        await pane.getByLabel('Clawd 动态设置').click();
        await pane.getByRole('button',{name:'减少 Clawd 动态效果'}).click();
        assert.equal(await pane.locator('[data-clawd-reduced=true]').count(),1);
      }
      assert.deepEqual(errors, []);
      report.push({width,height,theme,material,passed:true});
    } finally {await context.close();}
  }
} finally {await browser.close(); await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
