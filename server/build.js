#!/usr/bin/env node
'use strict';

/*
 * Packages cc-bridge.js into a single, dependency-free executable using
 * Node's built-in Single Executable Application (SEA) feature.
 *
 * Run this on the SAME platform/arch you intend to ship to (e.g. run it on
 * Windows to produce a Windows .exe) — cross-building a SEA blob for a
 * different OS is not officially guaranteed to work.
 *
 * Steps: esbuild bundle -> node --experimental-sea-config -> copy node
 * binary -> postject inject blob (+ embedded ui.html asset).
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const BUNDLE_PATH = path.join(DIST, 'bundle.js');
const BLOB_PATH = path.join(DIST, 'sea-prep.blob');
const SEA_CONFIG_PATH = path.join(DIST, 'sea-config.json');
const EXE_NAME = process.platform === 'win32' ? 'cc-bridge.exe' : 'cc-bridge';
const EXE_PATH = path.join(DIST, EXE_NAME);
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function requireDep(name) {
  try {
    return require(name);
  } catch (e) {
    console.error(`缺少依赖 ${name}，请先运行: npm install`);
    process.exit(1);
  }
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function step(label, fn) {
  console.log(`\n=== ${label} ===`);
  fn();
}

function main() {
  const majorVersion = parseInt(process.versions.node.split('.')[0], 10);
  if (majorVersion < 20) {
    console.error(`需要 Node 20 及以上才能使用 SEA 打包，当前版本: ${process.version}`);
    process.exit(1);
  }

  fs.mkdirSync(DIST, { recursive: true });
  const esbuild = requireDep('esbuild');

  step('1/4 esbuild bundling', () => {
    esbuild.buildSync({
      entryPoints: [path.join(ROOT, 'cc-bridge.js')],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      outfile: BUNDLE_PATH,
      external: ['node:sea'],
    });
    console.log(`bundle 输出: ${BUNDLE_PATH}`);
  });

  step('2/4 generating SEA blob', () => {
    const seaConfig = {
      main: toPosix(path.relative(DIST, BUNDLE_PATH)),
      output: toPosix(path.relative(DIST, BLOB_PATH)),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets: {
        'ui.html': toPosix(path.relative(DIST, path.join(ROOT, 'ui.html'))),
      },
    };
    fs.writeFileSync(SEA_CONFIG_PATH, JSON.stringify(seaConfig, null, 2));
    execFileSync(process.execPath, ['--experimental-sea-config', path.basename(SEA_CONFIG_PATH)], {
      cwd: DIST,
      stdio: 'inherit',
    });
  });

  step('3/4 copying node executable', () => {
    fs.copyFileSync(process.execPath, EXE_PATH);
    if (process.platform === 'win32') {
      console.log('Windows 提示: 如果下一步 postject 报签名相关错误，先手动执行:');
      console.log(`  signtool remove /s "${EXE_PATH}"`);
    } else {
      fs.chmodSync(EXE_PATH, 0o755);
    }
  });

  step('4/4 injecting blob with postject', () => {
    const postjectBin = require.resolve('postject/dist/cli.js');
    const args = [postjectBin, EXE_PATH, 'NODE_SEA_BLOB', BLOB_PATH, '--sentinel-fuse', SEA_FUSE];
    if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
    execFileSync(process.execPath, args, { stdio: 'inherit' });
  });

  console.log(`\n构建完成: ${EXE_PATH}`);
  console.log('把这一个文件发给使用者即可（ui.html 已内嵌），双击运行会在同目录生成 config.json。');
}

main();
