#!/usr/bin/env node
'use strict';

/*
 * Minimal MCP client that exercises all 8 tools plus the security/backup/
 * rate-limit behavior of a running mcp-file-server.js instance. Run the
 * server first (node mcp-file-server.js), then: node test/mcp-client-test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`找不到 ${CONFIG_PATH}，请先启动一次服务器生成配置（或跑 node mcp-file-server.js --setup）。`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

const config = loadConfig();
if (!config.allowedRoots || !config.allowedRoots.length) {
  console.error('config.json 的 allowedRoots 为空，测试脚本需要至少一个可写的白名单目录才能跑。');
  process.exit(1);
}

const BASE_URL = process.env.MCP_TEST_BASE_URL || `http://127.0.0.1:${config.port}/mcp`;
const TOKEN = process.env.MCP_TEST_TOKEN || config.token;
const TEST_ROOT = path.join(config.allowedRoots[0], 'mcp-client-test-tmp');

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}

async function connectedClient() {
  const client = new Client({ name: 'mcp-file-server-test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(BASE_URL), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  return client;
}

function callResult(result) {
  const block = result.content && result.content[0];
  if (!block || block.type !== 'text') throw new Error('unexpected tool result shape: ' + JSON.stringify(result));
  return JSON.parse(block.text);
}

function backupFilesFor(targetPath, baseName) {
  const backupDirAbs = path.isAbsolute(config.backupDir) ? config.backupDir : path.join(ROOT, config.backupDir);
  const relDir = path.dirname(path.relative(config.allowedRoots[0], targetPath));
  const backupSubDir = path.join(backupDirAbs, relDir === '.' ? '' : relDir);
  if (!fs.existsSync(backupSubDir)) return [];
  return fs.readdirSync(backupSubDir).filter((f) => f.startsWith(`${baseName}.`) && f.endsWith('.bak'));
}

async function main() {
  await fs.promises.rm(TEST_ROOT, { recursive: true, force: true });
  await fs.promises.mkdir(TEST_ROOT, { recursive: true });

  let client;

  await check('connect + listTools returns the 8 expected tools', async () => {
    client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = ['analyze_file', 'copy_files', 'delete_files', 'list_directory', 'move_files', 'read_files', 'search_files', 'write_files'];
    assert.deepStrictEqual(names, expected);
  });

  const fileA = path.join(TEST_ROOT, 'sub', 'a.txt');
  const fileB = path.join(TEST_ROOT, 'b.txt');

  await check('write_files creates files and auto-creates parent dirs', async () => {
    const data = callResult(await client.callTool({
      name: 'write_files',
      arguments: { files: [
        { path: fileA, content: 'hello\nworld\nline3\n' },
        { path: fileB, content: 'B content' },
      ] },
    }));
    assert.ok(data.every((d) => d.ok), 'expected all writes to succeed: ' + JSON.stringify(data));
    assert.ok(fs.existsSync(fileA));
  });

  await check('read_files returns matching content', async () => {
    const data = callResult(await client.callTool({ name: 'read_files', arguments: { files: [fileA, fileB] } }));
    assert.strictEqual(data.find((d) => d.path === fileA).content, 'hello\nworld\nline3\n');
    assert.strictEqual(data.find((d) => d.path === fileB).content, 'B content');
  });

  await check('read_files honors startLine/endLine', async () => {
    const data = callResult(await client.callTool({
      name: 'read_files',
      arguments: { files: [{ path: fileA, startLine: 2, endLine: 2 }] },
    }));
    assert.strictEqual(data[0].content, 'world');
  });

  await check('list_directory(recursive) sees written files', async () => {
    const data = callResult(await client.callTool({ name: 'list_directory', arguments: { path: TEST_ROOT, recursive: true } }));
    const flatten = (entries) => entries.flatMap((e) => (e.children ? [e, ...flatten(e.children)] : [e]));
    const names = flatten(data).map((e) => e.name);
    assert.ok(names.includes('a.txt') && names.includes('b.txt') && names.includes('sub'));
  });

  await check('overwriting an existing file triggers a backup', async () => {
    await client.callTool({ name: 'write_files', arguments: { files: [{ path: fileB, content: 'B content v2' }] } });
    assert.ok(backupFilesFor(fileB, 'b.txt').length >= 1);
  });

  await check('concurrent writes to the same path serialize and prune backups to retention', async () => {
    const target = path.join(TEST_ROOT, 'concurrent.txt');
    await client.callTool({ name: 'write_files', arguments: { files: [{ path: target, content: 'seed' }] } });
    const N = 15;
    await Promise.all(Array.from({ length: N }, (_, i) =>
      client.callTool({ name: 'write_files', arguments: { files: [{ path: target, content: `v${i}` }] } })
    ));
    const finalContent = fs.readFileSync(target, 'utf8');
    assert.ok(/^v\d+$/.test(finalContent), 'expected one clean final write, got: ' + JSON.stringify(finalContent));
    const backups = backupFilesFor(target, 'concurrent.txt');
    assert.ok(backups.length <= config.backupRetention, `expected <= ${config.backupRetention} backups, got ${backups.length}`);
  });

  await check('search_files matches by name pattern and by content', async () => {
    const byName = callResult(await client.callTool({ name: 'search_files', arguments: { rootPath: TEST_ROOT, namePattern: 'a.*' } }));
    assert.ok(byName.some((m) => m.path === fileA));
    const byContent = callResult(await client.callTool({ name: 'search_files', arguments: { rootPath: TEST_ROOT, contentPattern: 'world' } }));
    assert.ok(byContent.some((m) => m.path === fileA && m.lineNumber === 2));
  });

  await check('analyze_file returns a heuristic analysisNote', async () => {
    const data = callResult(await client.callTool({ name: 'analyze_file', arguments: { path: fileA } }));
    assert.ok(typeof data.analysisNote === 'string' && data.analysisNote.length > 0);
    assert.strictEqual(data.lineCount, 4);
  });

  const copyDest = path.join(TEST_ROOT, 'copy-of-b.txt');
  await check('copy_files creates a new destination', async () => {
    const data = callResult(await client.callTool({ name: 'copy_files', arguments: { items: [{ from: fileB, to: copyDest }] } }));
    assert.ok(data[0].ok, JSON.stringify(data));
    assert.ok(fs.existsSync(copyDest));
  });

  await check('copy_files backs up an existing destination before overwriting', async () => {
    await client.callTool({ name: 'copy_files', arguments: { items: [{ from: fileA, to: copyDest }] } });
    assert.ok(backupFilesFor(copyDest, 'copy-of-b.txt').length >= 1);
  });

  const moveDest = path.join(TEST_ROOT, 'moved.txt');
  await check('move_files relocates a file', async () => {
    const data = callResult(await client.callTool({ name: 'move_files', arguments: { items: [{ from: copyDest, to: moveDest }] } }));
    assert.ok(data[0].ok, JSON.stringify(data));
    assert.ok(!fs.existsSync(copyDest) && fs.existsSync(moveDest));
  });

  await check('delete_files removes a file and keeps a backup', async () => {
    const data = callResult(await client.callTool({ name: 'delete_files', arguments: { paths: [moveDest] } }));
    assert.ok(data[0].ok, JSON.stringify(data));
    assert.ok(!fs.existsSync(moveDest));
    assert.ok(backupFilesFor(moveDest, 'moved.txt').length >= 1);
  });

  await check('path traversal outside allowed roots is rejected', async () => {
    const data = callResult(await client.callTool({ name: 'read_files', arguments: { files: ['../../../../etc/passwd'] } }));
    assert.ok(data[0].error && /outside of allowed roots/.test(data[0].error), JSON.stringify(data));
  });

  await check('wrong token gets HTTP 401', async () => {
    const resp = await fetch(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.strictEqual(resp.status, 401);
  });

  await check('rapid requests eventually hit the rate limit (429)', async () => {
    const burst = config.rateLimit.maxRequests + 20;
    let sawTooMany = false;
    for (let i = 0; i < burst; i++) {
      const resp = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list', params: {} }),
      });
      if (resp.status === 429) {
        sawTooMany = true;
        break;
      }
    }
    assert.ok(sawTooMany, `expected a 429 within ${burst} rapid requests`);
  });

  await fs.promises.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});

  console.log('');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('失败项:');
    failed.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('测试脚本自身异常终止:', err);
  process.exitCode = 1;
});
