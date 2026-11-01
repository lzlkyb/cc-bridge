import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
/* global window, getComputedStyle, document */
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(path.join(root,'design/chat-workspace-2026-10-27/.qa/package.json'));
const {chromium}=require('playwright');
const out=path.join(root,'.impeccable/review/squad-composer');await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const report=[];
try {
 for(const [width,height,theme,material] of [[1800,1000,'light','classic'],[1280,840,'dark','classic'],[800,600,'dark','glass'],[560,700,'dark','glass'],[390,700,'light','glass']]){
  const context=await browser.newContext({viewport:{width,height}});const p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
  try {
   await p.goto(`http://127.0.0.1:1437/e2e/chat-workspace.html?scene=clawd&theme=${theme}&material=${material}`);
   const panel=p.locator('[data-cc-panel]:visible');await panel.locator('.cc-clawd-label').waitFor();
   await p.evaluate(async()=>{await window.ccClawdEvent({kind:'init',sessionId:'squad-design',cwd:'D:/projects/web-console',model:'opus'});await window.ccClawdEvent({kind:'userMessage',text:'排查登录请求，修复后独立审查并验证'});for(let index=0;index<8;index++){await window.ccClawdEvent({kind:'taskUpdate',task:{taskId:`squad-${index}`,stopToken:`token-${index}`,name:['Explore','Implement','Review','Verify'][index%4],description:['梳理登录请求链路','修复超时与重试逻辑','核对刷新令牌的影响范围','整理回归验证用例'][index%4],summary:['正在读取登录入口','已定位重试配置','正在对照调用路径','等待本轮修改完成'][index%4],lastToolName:['Read','Edit','Read','Bash'][index%4],taskType:'local_agent',background:true,status:index===7?'completed':'running'}});}});
   const roster=panel.getByRole('complementary',{name:'协作小队',exact:true});await roster.waitFor();assert.equal(await roster.locator('.cc-clawd-member').count(),8);
   assert.equal(await panel.getByRole('button',{name:/展开小队|另有.*成员/}).count(),0);
   const layout=await panel.evaluate(e=>{const box=s=>{const{left,top,right,bottom,width,height}=e.querySelector(s).getBoundingClientRect();return{left,top,right,bottom,width,height};};return{panel:box('.cc-conversation-layout'),stream:box('[data-cc-stream]'),host:box('.cc-squad-host'),composer:box('[data-cc-composer]'),overflow:e.scrollWidth>e.clientWidth+2};});
   assert.equal(layout.overflow,false);const actions=await roster.locator('.cc-clawd-member-actions').first().boundingBox();assert.ok(actions.y+actions.height<=layout.host.bottom+1,'member actions must be visible without vertical scrolling');assert.ok(layout.stream.height>=100,`reading area too short: ${JSON.stringify(layout)}`);
   if(layout.panel.width>=1100)assert.ok(layout.host.left>=layout.stream.right-2);else assert.ok(layout.host.top>=layout.stream.bottom-2);
   const palettes=await roster.locator('svg[data-palette]').evaluateAll(es=>[...new Set(es.map(e=>e.dataset.palette))]);assert.ok(palettes.length>=3);
   assert.equal(await roster.locator('[data-motion=full]').count(),2);
   const draft=panel.getByRole('textbox',{name:'消息',exact:true});await draft.focus();assert.equal(await roster.locator('.body').first().evaluate(e=>getComputedStyle(e).animationPlayState),'paused');
   await panel.getByRole('button',{name:'引用文件',exact:true}).click();assert.match(await draft.inputValue(),/@/);
   await draft.fill('');await panel.getByRole('button',{name:'查看命令',exact:true}).first().click();assert.equal(await draft.inputValue(),'/');await draft.fill('');await p.evaluate(()=>document.activeElement?.blur());
   await p.screenshot({path:path.join(out,`${width}-${theme}-${material}.png`),fullPage:true});
   await panel.getByLabel('Clawd 动态设置').click();await panel.getByRole('button',{name:'减少 Clawd 动态效果'}).click();assert.equal(await roster.locator('.body').first().evaluate(e=>getComputedStyle(e).animationName),'none');
   await panel.getByRole('button',{name:'选择发送方式',exact:true}).click();await p.getByRole('button',{name:/下一轮发送.*当前任务结束/}).click();await draft.fill('请优先检查登录重试');await panel.getByRole('button',{name:'排队发送',exact:true}).click();await panel.locator('.cc-composer-queue-peek').filter({hasText:'请优先检查登录重试'}).waitFor();assert.equal(await draft.inputValue(),'');
   assert.deepEqual(errors,[]);report.push({width,height,theme,material,layout,passed:true});
  }finally{await context.close();}
 }
}finally{await browser.close();await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
