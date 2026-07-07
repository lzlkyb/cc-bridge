#!/usr/bin/env node
'use strict';

/*
 * Copies the SEA-built cc-bridge executable into src-tauri/binaries/ using
 * Tauri's required sidecar naming convention: <name>-<rust-target-triple>[.exe].
 * Run `node ../server/build.js` first to produce the exe this copies.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const EXE_NAME = process.platform === 'win32' ? 'cc-bridge.exe' : 'cc-bridge';
const SOURCE_EXE = path.join(ROOT, '..', 'server', 'dist', EXE_NAME);
const BINARIES_DIR = path.join(ROOT, 'src-tauri', 'binaries');

function getRustTargetTriple() {
  let output;
  try {
    output = execSync('rustc -vV', { encoding: 'utf8' });
  } catch (e) {
    console.error('无法运行 `rustc -vV`，请确认已安装 Rust 工具链: ' + e.message);
    process.exit(1);
  }
  const match = /host:\s*(\S+)/.exec(output);
  if (!match) {
    console.error('未能从 `rustc -vV` 输出里解析出 host target triple');
    process.exit(1);
  }
  return match[1];
}

function main() {
  if (!fs.existsSync(SOURCE_EXE)) {
    console.error(`找不到 ${SOURCE_EXE}`);
    console.error('请先在 ../server 目录下运行: node build.js');
    process.exit(1);
  }
  const triple = getRustTargetTriple();
  fs.mkdirSync(BINARIES_DIR, { recursive: true });
  const ext = process.platform === 'win32' ? '.exe' : '';
  const destPath = path.join(BINARIES_DIR, `cc-bridge-${triple}${ext}`);
  fs.copyFileSync(SOURCE_EXE, destPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(destPath, 0o755);
  }
  console.log(`已复制 sidecar 二进制: ${destPath}`);
}

main();
