import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
/* global window */
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'design/chat-workspace-2026-10-27/.qa/package.json'));
const {chromium} = require('playwright');
const out = path.join(root,'.impeccable/review/task-stop'); await mkdir(out,{recursive:true});
const browser = await chromium.launch({channel:'msedge',headless:true}); const report=[];
try {
  for (const width of [1280,800,390]) {
    const context = await browser.newContext({viewport:{width,height:840}}); const p = await context.newPage(); const errors=[];
    p.on('pageerror',e=>errors.push(e.message));
    try {
      await p.goto('http://127.0.0.1:1437/e2e/chat-workspace.html?scene=clawd&theme=dark&material=glass');
      const panel=p.locator('[data-cc-panel]:visible'); await panel.locator('.cc-clawd-label').waitFor();
      await p.evaluate(async()=> { await window.ccClawdEvent({kind:'init',sessionId:'review-session',cwd:'D:/projects/web-console',model:'opus'}); await window.ccClawdEvent({kind:'userMessage',text:'检查两个后台任务并继续编辑'}); });
      await p.evaluate(async()=> { for (const taskId of ['a','b']) await window.ccClawdEvent({kind:'taskUpdate',task:{taskId,stopToken:`token-${taskId}`,description:`检查 ${taskId}`,taskType:'local_agent',background:true,status:'running'}}); });
      await panel.getByRole('complementary',{name:'协作小队',exact:true}).waitFor();
      assert.equal(await panel.evaluate(el=>el.scrollWidth>el.clientWidth+2),false);
      const a=panel.getByRole('button',{name:'停止成员：检查 a',exact:true});
      await a.click(); assert.equal(await a.isDisabled(),true);
      await panel.locator('.cc-clawd-agent').first().click(); await panel.getByRole('button',{name:'关闭成员详情',exact:true}).click();
      await panel.getByRole('complementary',{name:'协作小队',exact:true}).waitFor(); assert.equal(await a.isDisabled(),true);
      assert.deepEqual(await p.evaluate(()=>window.ccTaskStopTest.calls()),[{command:'cc_stop_task',sessionId:1,taskId:'a',stopToken:'token-a'}]);
      await p.screenshot({path:path.join(out,`${width}-stopping.png`)});
      await p.evaluate(()=>window.ccTaskStopTest.confirm('a'));
      await panel.getByRole('complementary',{name:'协作小队',exact:true}).waitFor();
      await panel.getByText('停止已确认',{exact:true}).waitFor();
      assert.equal(await a.count(),0); assert.equal(await panel.getByRole('button',{name:'停止成员：检查 b',exact:true}).count(),1);
      await p.evaluate(()=>window.ccClawdEvent({kind:'toolUse',toolUseId:'main-continues',name:'Edit',input:{file_path:'src/api/client.ts'}}));
      await panel.locator('.cc-clawd-label').filter({hasText:'正在编辑文件'}).waitFor();
      const b=panel.getByRole('button',{name:'停止成员：检查 b',exact:true}); await b.click();
      await p.evaluate(()=>window.ccTaskStopTest.reject('b','CLI 不支持 stop_task'));
      await panel.getByText('CLI 不支持 stop_task',{exact:true}).waitFor(); assert.equal(await b.isEnabled(),true);
      await b.click(); await p.evaluate(()=>window.ccTaskStopTest.confirm('b','completed'));
      await panel.getByText('任务已完成，无需停止',{exact:true}).waitFor();
      assert.deepEqual(errors,[]); report.push({width,passed:true});
    } finally {await context.close();}
  }
} finally {await browser.close(); await writeFile(path.join(out,'browser-report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
