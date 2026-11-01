import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
/* global window, getComputedStyle */
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(path.join(root,'design/chat-workspace-2026-10-27/.qa/package.json'));
const {chromium}=require('playwright');
const out=path.join(root,'.impeccable/review/steering');await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true}),report=[];
try{
 for(const [width,height,theme,material] of [[1440,900,'dark','classic'],[800,600,'light','glass'],[390,700,'light','glass']]){
  const context=await browser.newContext({viewport:{width,height}}),p=await context.newPage(),errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  try{
   await p.goto(`http://127.0.0.1:1437/e2e/chat-workspace.html?scene=clawd&theme=${theme}&material=${material}`,{waitUntil:'domcontentloaded',timeout:60000});
   const panel=p.locator('[data-cc-panel]:visible'),draft=panel.getByRole('textbox',{name:'消息',exact:true});
   await panel.locator('.cc-clawd-label').waitFor();
   await p.evaluate(async()=>{await window.ccClawdEvent({kind:'init',sessionId:'review-session',cwd:'D:/projects/web-console',model:'opus'});await window.ccClawdEvent({kind:'userMessage',text:'继续检查登录链路'});});
   await draft.fill('默认补充当前任务');await panel.getByRole('button',{name:'补充发送',exact:true}).click();
   await panel.locator('.cc-input-status').filter({hasText:'等待 CLI 接收'}).first().waitFor();
   assert.equal(await draft.inputValue(),'');
   let calls=await p.evaluate(()=>window.ccSteeringTest.calls());
   assert.equal(calls.length,1);assert.equal(calls[0].input.mode,'steer');
   const id=calls[0].input.messageId;
   for(const [status,label] of [['received','CLI 已接收'],['processing','已进入回复'],['complete','本轮已结束'],['written','本轮已结束']]){
    await p.evaluate(([id,status])=>window.ccSteeringTest.receipt(id,status),[id,status]);
    await panel.locator('.cc-input-status').filter({hasText:label}).first().waitFor();
   }
   await draft.fill('/');await p.getByLabel('slash 命令',{exact:true}).getByRole('button').first().click({trial:true});await draft.fill('');
   await panel.getByRole('button',{name:'选择发送方式',exact:true}).click();await p.getByRole('button',{name:/下一轮发送.*当前任务结束/}).click();
   await draft.fill('下一轮独立审查');await panel.getByRole('button',{name:'排队发送',exact:true}).click();
   await panel.locator('.cc-composer-queue-peek').filter({hasText:'下一轮独立审查'}).waitFor();
   await draft.fill('现在调整方向');await draft.press('Control+Enter');
   await panel.locator('.cc-input-preview').filter({hasText:'现在调整方向'}).first().waitFor();
   calls=await p.evaluate(()=>window.ccSteeringTest.calls());
   assert.equal(calls.filter(c=>c.command==='cc_steer'&&c.input.mode==='now').length,1);
   assert.equal(calls.filter(c=>c.command==='cc_interrupt'||c.command==='cc_start').length,0);
   await p.evaluate(()=>window.ccSteeringTest.failNext());
   await panel.locator('input[type=file]').setInputFiles(path.join(root,'desktop/src-tauri/icons/32x32.png'));
   await panel.getByRole('button',{name:'移除这张图',exact:true}).waitFor();
   await draft.fill('失败后保留文字与图片');await panel.getByRole('button',{name:'补充发送',exact:true}).click();
   await panel.locator('.cc-input-status').filter({hasText:'补充未发送'}).first().waitFor();
   assert.equal(await draft.inputValue(),'失败后保留文字与图片');
   assert.equal(await panel.getByRole('button',{name:'移除这张图',exact:true}).count(),1);
   await p.evaluate(()=>window.ccClawdEvent({kind:'exit',code:null}));
   await panel.locator('.cc-composer-queue').filter({hasText:'队列已暂停'}).waitFor();
   calls=await p.evaluate(()=>window.ccSteeringTest.calls());assert.equal(calls.filter(c=>c.command==='cc_start').length,0);
   await p.waitForTimeout(350);
   const layout=await panel.evaluate(e=>{const box=s=>{const b=e.querySelector(s).getBoundingClientRect();return{top:b.top,bottom:b.bottom};};const composer=box('[data-cc-composer]'),pane=e.getBoundingClientRect();return{overflow:e.scrollWidth>e.clientWidth+2,composerBottom:composer.bottom,paneBottom:pane.bottom,clawd:box('.cc-clawd-dock'),receipts:box('.cc-input-receipts'),tools:box('.cc-composer-tools'),footer:box('.cc-composer-footer'),grid:box('.cc-conversation-layout'),stream:box('.cc-clawd-stream'),dock:box('.cc-composer-dock'),rows:getComputedStyle(e.querySelector('.cc-conversation-layout')).gridTemplateRows,dockOverflow:getComputedStyle(e.querySelector('.cc-composer-dock')).overflowY};});
   assert.equal(layout.overflow,false);assert.ok(layout.composerBottom<=layout.paneBottom+2);
   assert.ok(layout.clawd.bottom<=layout.receipts.top+1,JSON.stringify(layout));assert.ok(layout.tools.bottom<=layout.composerBottom+1,JSON.stringify(layout));assert.ok(layout.tools.bottom<=layout.footer.top+1,JSON.stringify(layout));assert.ok(layout.tools.bottom<=layout.paneBottom,JSON.stringify(layout));
   await p.screenshot({path:path.join(out,`ui-${width}-${theme}.png`),fullPage:true});
   assert.deepEqual(errors,[]);report.push({width,height,theme,material,passed:true,checks:8,layout});
  }finally{await context.close();}
 }
}finally{await browser.close();await writeFile(path.join(out,'browser-report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
