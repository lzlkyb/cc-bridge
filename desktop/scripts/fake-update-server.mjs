#!/usr/bin/env node
/**
 * fake-update-server.mjs —— 本地假更新源，用来反复测自动更新链路（**仅测试用**）。
 *
 * 为什么需要它：真实更新源在 Gitee / GitHub 上，测一次「检查更新 → 下载 → 失败」
 * 就得发一个真版本或者等网络。而这条链路有 11 个可观测状态，绝大多数（源不可达、
 * 验签失败、无 Content-Length、下载卡住、已是最新）都需要**刻意制造异常**才能看到。
 * 有了这个 server，异常是想触发就触发的开关，而不是运气。
 *
 * 能不能直接用它测「装完重启」？**不能**。它给的签名是假的（等价于一个签名坏掉的
 * 更新包），插件会在下载完成后验签失败、根本不会执行安装 —— 这正好是它最有用的
 * 用途：把「检查 → 下载 → 进度 → 失败」整段跑通，而**永远不会动你已安装的应用**。
 * 要验真正的安装与重启，见 docs/自动更新流程测试指南-2026-10-18.md 的 Layer 2/3。
 *
 * ── 用法 ──────────────────────────────────────────────────────────
 *   node desktop/scripts/fake-update-server.mjs                    # 默认 99.9.9 / 20MB / 2MB/s
 *   node desktop/scripts/fake-update-server.mjs --version 2.9.1    # 测「已是最新」
 *   node desktop/scripts/fake-update-server.mjs --mode stall       # 传到 30% 卡住 4 秒
 *   node desktop/scripts/fake-update-server.mjs --mode noclen      # 不给 Content-Length
 *   node desktop/scripts/fake-update-server.mjs --mode 404         # 元数据 404
 *   node desktop/scripts/fake-update-server.mjs --mode badjson     # 返回一段坏 JSON
 *
 * ── 参数 ──────────────────────────────────────────────────────────
 *   --port <n>        监听端口，默认 8899
 *   --version <ver>   updater.json 里声明的版本，默认 99.9.9（必须大于运行中的版本才会触发更新）
 *   --size-mb <n>     假安装包大小，默认 20
 *   --rate-kbps <n>   下载限速（KB/s），默认 2048；0 = 不限速（进度会一闪而过）
 *   --mode <m>        ok | slow | stall | noclen | 404 | badjson | zero
 *                     slow   = 限速到 300KB/s，方便截图看读数
 *                     stall  = 正常传，但在 ~30% 处静默卡 4 秒（测前端「等待响应…」）
 *                     noclen = 用 chunked，不给 Content-Length（测进度条不确定态）
 *                     404    = updater.json 返回 404（测源不可达/回退）
 *                     badjson= updater.json 返回非 JSON（测解析错误文案）
 *                     zero   = 安装包 0 字节（测下载边界）
 *   --sig <str>       覆盖 signature 字段（默认是明显非法的占位串 ⇒ 验签必失败 ⇒ 不会安装）
 *
 * Windows 下让应用指向本地源（Git Bash）：
 *   export CCBRIDGE_UPDATE_ENDPOINT=http://127.0.0.1:8899/updater.json
 *   cd desktop && npm run dev
 * 注意：release 构建拒绝 http（只有 debug 允许），所以这个用法只对 `npm run dev` 有效。
 */

import http from "node:http";
import { randomBytes } from "node:crypto";
// 从 node:timers 显式 import：本项目 eslint 的 globals 里没有 setTimeout/setImmediate，
// 直接裸用会被 no-undef 拦（`npx eslint .` 是门禁之一）。
import { setImmediate as soon, setTimeout as after } from "node:timers";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PORT = Number(arg("port", "8899"));
const VERSION = arg("version", "99.9.9");
const SIZE_MB = Number(arg("size-mb", "20"));
const MODE = arg("mode", "ok");
const RATE_KBPS = MODE === "slow" ? 300 : Number(arg("rate-kbps", "2048"));
const SIG = arg("sig", "ZmFrZS1zaWduYXR1cmUtZm9yLXVwZGF0ZXItdGVzdA==");
const BIN_NAME = "cc-bridge-fake_99.9.9_x64-setup.exe";
const TOTAL = MODE === "zero" ? 0 : SIZE_MB * 1024 * 1024;
const BASE = `http://127.0.0.1:${PORT}`;

const manifest = {
  version: VERSION,
  notes: "本地假更新源：签名是假的，下载完会验签失败（这是刻意的，用来测失败路径）",
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature: SIG, url: `${BASE}/${BIN_NAME}` },
    "darwin-aarch64": { signature: SIG, url: `${BASE}/${BIN_NAME}` },
  },
};

function log(...a) {
  console.log("[fake-update]", ...a);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  log(`${req.method} ${url.pathname}`);

  // ── 元数据 ────────────────────────────────────────────────
  if (url.pathname === "/updater.json") {
    if (MODE === "404") {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found (mode=404)\n");
      return;
    }
    if (MODE === "badjson") {
      res.writeHead(200, { "content-type": "application/json" }).end("{ this is not json ");
      return;
    }
    const body = JSON.stringify(manifest, null, 2);
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  // ── 假安装包 ──────────────────────────────────────────────
  if (url.pathname === `/${BIN_NAME}`) {
    const chunked = MODE === "noclen";
    const headers = { "content-type": "application/octet-stream" };
    if (!chunked) headers["content-length"] = String(TOTAL);
    res.writeHead(200, headers);

    if (TOTAL === 0) {
      res.end();
      log("已发送 0 字节（mode=zero）");
      return;
    }

    // 速率控制：把总时长摊到固定分片数上。分片 32KB，按目标速率算每片应耗时多少。
    const CHUNK = 32 * 1024;
    const bytesPerSec = RATE_KBPS > 0 ? RATE_KBPS * 1024 : 0;
    const delayMs = bytesPerSec > 0 ? (CHUNK / bytesPerSec) * 1000 : 0;
    const stallAt = MODE === "stall" ? Math.floor(TOTAL * 0.3) : -1;
    let sent = 0;
    let stalled = false;

    const pump = () => {
      if (res.writableEnded || res.destroyed) return;
      const n = Math.min(CHUNK, TOTAL - sent);
      // 内容无所谓（反正签名会失败），但用随机字节避免被任何中间层压缩/短路。
      res.write(randomBytes(n));
      sent += n;
      if (sent >= TOTAL) {
        res.end();
        log(`已发送 ${sent} 字节（${MODE}）`);
        return;
      }
      if (!stalled && stallAt > 0 && sent >= stallAt) {
        stalled = true;
        log(`已发 ${sent}/${TOTAL}，静默卡 4 秒（测前端 STALL_MS=1500 的「等待响应…」）`);
        after(pump, 4000);
        return;
      }
      if (delayMs > 0) after(pump, delayMs);
      else soon(pump);
    };
    pump();
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" }).end("404\n");
});

server.listen(PORT, "127.0.0.1", () => {
  log(`监听 ${BASE}`);
  log(`版本=${VERSION}  大小=${SIZE_MB}MB  限速=${RATE_KBPS || "不限"}KB/s  mode=${MODE}`);
  log(`签名=占位串（下载完成会验签失败 ⇒ 不会安装，安全）`);
  log("");
  log("把应用指过来（Git Bash）：");
  log(`  export CCBRIDGE_UPDATE_ENDPOINT=${BASE}/updater.json`);
  log("  cd desktop && npm run dev");
  log("");
  log("只验证源可达：");
  log(`  curl -s ${BASE}/updater.json`);
});
