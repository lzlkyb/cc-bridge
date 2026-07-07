#!/usr/bin/env node
'use strict';

/*
 * cc-bridge — local file bridge so a remote Claude Code instance can
 * read/write files on this machine over the standard MCP protocol
 * (Streamable HTTP transport), instead of scp/SSHFS.
 *
 * Single-file core logic by design. build.js (packaging) and
 * test/mcp-client-test.js (verification) are separate, non-overlapping files.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { AsyncLocalStorage } = require('async_hooks');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const VERSION = '1.0.0';

// ============ SECTION: base dir / config path ============
// __dirname is not reliable inside a Node SEA executable (the code is an
// embedded blob, not loaded from a real file path), so config/backup/audit
// paths must resolve relative to the running executable itself when packaged.
//
// CC_BRIDGE_DATA_DIR overrides both, for when this exe runs as a
// sidecar spawned by the Tauri desktop shell: an installed app's sidecar
// binary typically lives under Program Files (not writable by a normal
// user), so the desktop shell points this at a real per-user data dir
// instead (e.g. %APPDATA%\...). Standalone/portable use (double-clicking
// the exe directly, or plain `node cc-bridge.js`) is unaffected.
function getBaseDir() {
  if (process.env.CC_BRIDGE_DATA_DIR) {
    return process.env.CC_BRIDGE_DATA_DIR;
  }
  try {
    const sea = require('node:sea');
    if (sea.isSea && sea.isSea()) {
      return path.dirname(process.execPath);
    }
  } catch (e) {
    // 'node:sea' unavailable or not running as SEA — normal dev mode.
  }
  return __dirname;
}

// Guaranteed to exist before anything reads/writes into it — matters most
// for CC_BRIDGE_DATA_DIR overrides, which may point at a fresh
// per-user data directory that hasn't been created yet.
fs.mkdirSync(getBaseDir(), { recursive: true });

const CONFIG_PATH = path.join(getBaseDir(), 'config.json');

const DEFAULT_EXTENSIONS = [
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.json', '.py', '.java', '.go', '.rs',
  '.c', '.cpp', '.h', '.hpp', '.cs',
  '.rb', '.php', '.sh', '.bash',
  '.yml', '.yaml', '.toml', '.ini',
  '.md', '.txt', '.html', '.css', '.scss',
  '.sql', '.xml',
];

const EXT_LANGUAGE_MAP = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.rb': 'ruby', '.php': 'php', '.sh': 'shell', '.bash': 'shell',
  '.md': 'markdown', '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml',
  '.html': 'html', '.css': 'css', '.sql': 'sql', '.xml': 'xml',
};

// Heuristic regex-based function/class counters, grouped by language.
// These are approximations, not AST-accurate parsing.
const FUNCTION_PATTERNS = {
  javascript: { fn: [/\bfunction\s+\w+/g, /=>\s*\{/g], cls: [/\bclass\s+\w+/g] },
  typescript: { fn: [/\bfunction\s+\w+/g, /=>\s*\{/g], cls: [/\bclass\s+\w+/g] },
  python: { fn: [/^\s*def\s+\w+/gm], cls: [/^\s*class\s+\w+/gm] },
  java: { fn: [/\b(?:public|private|protected|static)[^;{}]*\([^)]*\)\s*\{/g], cls: [/\bclass\s+\w+/g] },
  go: { fn: [/\bfunc\s+\w+/g], cls: [] },
  rust: { fn: [/\bfn\s+\w+/g], cls: [/\bstruct\s+\w+/g] },
  c: { fn: [/\b\w+\s+\w+\s*\([^;{]*\)\s*\{/g], cls: [] },
  cpp: { fn: [/\b\w+\s+\w+\s*\([^;{]*\)\s*\{/g], cls: [/\bclass\s+\w+/g] },
  csharp: { fn: [/\b(?:public|private|protected|static)[^;{}]*\([^)]*\)\s*\{/g], cls: [/\bclass\s+\w+/g] },
  ruby: { fn: [/^\s*def\s+\w+/gm], cls: [/^\s*class\s+\w+/gm] },
  php: { fn: [/\bfunction\s+\w+/g], cls: [/\bclass\s+\w+/g] },
};

const requestContext = new AsyncLocalStorage();
const pathLocks = new Map();
const rateLimitState = new Map();
const stats = { totalRequests: 0, totalErrors: 0, startedAt: Date.now() };

class SecurityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SecurityError';
    this.code = code || 'PATH_DENIED';
  }
}

// ============ SECTION: config loading ============
function defaultConfig() {
  return {
    allowedRoots: [],
    token: crypto.randomBytes(32).toString('hex'),
    allowedExtensions: DEFAULT_EXTENSIONS.slice(),
    maxFileSizeBytes: 20 * 1024 * 1024,
    rateLimit: { maxRequests: 100, windowMs: 60000 },
    backupDir: '.cc-bridge-backup',
    backupRetention: 10,
    auditLogPath: 'audit.log',
    host: '0.0.0.0',
    port: 7823,
  };
}

function isWithinRoot(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function recomputeAllowedRootsResolved(cfg) {
  cfg.allowedRootsResolved = [];
  for (const root of cfg.allowedRoots) {
    try {
      cfg.allowedRootsResolved.push(fs.realpathSync(root));
    } catch (e) {
      console.error(`警告: allowedRoots 中的目录不存在或不可访问，已忽略: ${root} (${e.message})`);
    }
  }
}

function finalizeConfig(cfg) {
  recomputeAllowedRootsResolved(cfg);
  const backupDirAbs = path.isAbsolute(cfg.backupDir) ? cfg.backupDir : path.join(getBaseDir(), cfg.backupDir);
  let backupReal = backupDirAbs;
  try {
    backupReal = fs.realpathSync(backupDirAbs);
  } catch (e) {
    // backup dir may not exist yet — created lazily on first backup.
  }
  if (cfg.allowedRootsResolved.some((root) => isWithinRoot(root, backupReal))) {
    console.error(`警告: backupDir (${backupDirAbs}) 位于某个 allowedRoot 内，可能导致递归备份自身`);
  }
  return cfg;
}

const PERSISTABLE_CONFIG_KEYS = [
  'allowedRoots', 'token', 'allowedExtensions', 'maxFileSizeBytes',
  'rateLimit', 'backupDir', 'backupRetention', 'auditLogPath', 'host', 'port',
];

function toPersistableConfig(cfg) {
  const out = {};
  for (const key of PERSISTABLE_CONFIG_KEYS) out[key] = cfg[key];
  return out;
}

function persistConfigToDisk(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toPersistableConfig(cfg), null, 2), { mode: 0o600 });
}

function loadOrInitConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = defaultConfig();
    persistConfigToDisk(cfg);
    console.error(`未找到 config.json，已生成默认配置: ${CONFIG_PATH}`);
    console.error(`生成的 token: ${cfg.token}`);
    console.error('allowedRoots 为空，服务器将以“全部拒绝”安全模式启动。');
    console.error('请编辑 config.json 的 allowedRoots 后重启，或运行: node cc-bridge.js --setup');
    return finalizeConfig(cfg);
  }

  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (e) {
    console.error(`无法读取 config.json: ${e.message}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`config.json 解析失败: ${e.message}`);
    process.exit(1);
  }

  if (!parsed.token || typeof parsed.token !== 'string') {
    console.error('config.json 缺少必填的 token 字段');
    process.exit(1);
  }

  const merged = Object.assign(defaultConfig(), parsed);
  merged.allowedRoots = Array.isArray(parsed.allowedRoots) ? parsed.allowedRoots : [];
  return finalizeConfig(merged);
}

// ============ SECTION: config mutation (web panel) ============
// Mutates the single shared in-memory config object in place — every tool
// handler and HTTP route already reads config.* at call time (not a copy
// taken at startup), so allowedRoots/allowedExtensions/rateLimit/etc. take
// effect on the very next request. port/host cannot be hot-applied because
// the listening socket is already bound; those are persisted but flagged
// restartRequired instead.
function validateAndApplyConfigPatch(config, patch) {
  const errors = {};
  const warnings = [];
  const next = {};
  let restartRequired = false;

  if (patch.allowedRoots !== undefined) {
    if (!Array.isArray(patch.allowedRoots) || !patch.allowedRoots.every((p) => typeof p === 'string' && p.trim())) {
      errors.allowedRoots = 'allowedRoots 必须是非空字符串组成的数组';
    } else {
      const roots = patch.allowedRoots.map((p) => path.resolve(p.trim()));
      for (const r of roots) {
        if (!fs.existsSync(r)) warnings.push(`目录当前不存在，已保存但暂时不会生效: ${r}`);
      }
      next.allowedRoots = roots;
    }
  }

  if (patch.allowedExtensions !== undefined) {
    if (!Array.isArray(patch.allowedExtensions) || !patch.allowedExtensions.every((e) => typeof e === 'string')) {
      errors.allowedExtensions = 'allowedExtensions 必须是字符串数组';
    } else {
      next.allowedExtensions = patch.allowedExtensions
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
        .map((e) => (e.startsWith('.') ? e : `.${e}`));
    }
  }

  if (patch.maxFileSizeBytes !== undefined) {
    const v = Number(patch.maxFileSizeBytes);
    if (!Number.isFinite(v) || v <= 0) errors.maxFileSizeBytes = '必须是正数';
    else next.maxFileSizeBytes = Math.floor(v);
  }

  if (patch.rateLimit !== undefined) {
    const rl = patch.rateLimit || {};
    const maxRequests = Number(rl.maxRequests);
    const windowMs = Number(rl.windowMs);
    if (!Number.isFinite(maxRequests) || maxRequests <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
      errors.rateLimit = 'maxRequests 和 windowMs 都必须是正数';
    } else {
      next.rateLimit = { maxRequests: Math.floor(maxRequests), windowMs: Math.floor(windowMs) };
    }
  }

  if (patch.backupRetention !== undefined) {
    const v = Number(patch.backupRetention);
    if (!Number.isInteger(v) || v < 1) errors.backupRetention = '必须是 >= 1 的整数';
    else next.backupRetention = v;
  }

  if (patch.port !== undefined) {
    const v = Number(patch.port);
    if (!Number.isInteger(v) || v < 1 || v > 65535) errors.port = '必须是 1-65535 之间的整数';
    else {
      next.port = v;
      restartRequired = true;
    }
  }

  if (patch.host !== undefined) {
    if (typeof patch.host !== 'string' || !patch.host.trim()) errors.host = '必须是非空字符串';
    else {
      next.host = patch.host.trim();
      restartRequired = true;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  Object.assign(config, next);
  if (next.allowedRoots) recomputeAllowedRootsResolved(config);
  persistConfigToDisk(config);

  return { ok: true, changed: Object.keys(next), warnings, restartRequired };
}

function regenerateToken(config) {
  config.token = crypto.randomBytes(32).toString('hex');
  persistConfigToDisk(config);
  return config.token;
}

// ============ SECTION: filesystem browse (for the "choose a folder" UI) ============
// Deliberately not gated by allowedRoots — its purpose is to help pick NEW
// roots that aren't whitelisted yet. Read-only (directory names only, never
// file contents), and still requires the same Bearer token as everything else.
function listBrowseRoots() {
  if (process.platform === 'win32') {
    const roots = [];
    for (let i = 65; i <= 90; i++) {
      const drive = `${String.fromCharCode(i)}:\\`;
      if (fs.existsSync(drive)) roots.push({ name: drive, path: drive });
    }
    return roots;
  }
  return [{ name: '/', path: '/' }];
}

async function browseDirectory(inputPath) {
  if (!inputPath) {
    return { path: null, parent: null, entries: listBrowseRoots() };
  }
  const normalized = path.normalize(inputPath);
  let real;
  try {
    real = fs.realpathSync(normalized);
  } catch (e) {
    throw new Error(`目录不存在或不可访问: ${e.message}`);
  }
  const st = await fsp.stat(real);
  if (!st.isDirectory()) throw new Error('不是一个目录');

  let dirents;
  try {
    dirents = await fsp.readdir(real, { withFileTypes: true });
  } catch (e) {
    throw new Error(`无法读取目录: ${e.message}`);
  }
  const entries = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    entries.push({ name: d.name, path: path.join(real, d.name) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parentDir = path.dirname(real);
  const isAtRoot = parentDir === real;
  return { path: real, parent: isAtRoot ? null : parentDir, entries };
}

// ============ SECTION: path security ============
function resolveSafePath(inputPath, config) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new SecurityError('path must be a non-empty string', 'INVALID_PATH');
  }
  const absPath = path.isAbsolute(inputPath) ? inputPath : path.resolve(getBaseDir(), inputPath);
  const normalized = path.normalize(absPath);

  // Walk up to the deepest existing ancestor so brand-new paths (e.g. a file
  // about to be created) can still be realpath-checked via their parent.
  let existingPart = normalized;
  let remainder = '';
  while (!fs.existsSync(existingPart)) {
    const parent = path.dirname(existingPart);
    if (parent === existingPart) break;
    remainder = remainder ? path.join(path.basename(existingPart), remainder) : path.basename(existingPart);
    existingPart = parent;
  }

  let realExisting;
  try {
    realExisting = fs.realpathSync(existingPart);
  } catch (e) {
    throw new SecurityError(`cannot resolve path: ${e.message}`, 'PATH_DENIED');
  }
  const realFull = remainder ? path.join(realExisting, remainder) : realExisting;

  const allowed = (config.allowedRootsResolved || []).some((root) => isWithinRoot(root, realFull));
  if (!allowed) {
    throw new SecurityError(`path is outside of allowed roots: ${inputPath}`, 'PATH_DENIED');
  }

  return { resolvedPath: normalized, realPath: realFull };
}

function assertExtensionAllowed(filePath, config) {
  if (!config.allowedExtensions || config.allowedExtensions.length === 0) return;
  const ext = path.extname(filePath).toLowerCase();
  if (!config.allowedExtensions.includes(ext)) {
    throw new SecurityError(`extension not allowed: ${ext || '(none)'}`, 'EXTENSION_DENIED');
  }
}

function assertFileSizeOk(size, config) {
  if (size > config.maxFileSizeBytes) {
    const err = new Error('FILE_TOO_LARGE');
    err.code = 'FILE_TOO_LARGE';
    throw err;
  }
}

async function fileExists(p) {
  try {
    await fsp.stat(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

function guessEncoding(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf8-bom';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf16be';
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let zeroCount = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) zeroCount++;
  if (sample.length > 0 && zeroCount / sample.length > 0.1) return 'binary';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return 'utf8';
  } catch (e) {
    return 'unknown';
  }
}

// ============ SECTION: per-path write lock (in-process, not OS-level) ============
function withPathLock(key, fn) {
  const prevTail = pathLocks.get(key) || Promise.resolve();
  const runPromise = prevTail.then(fn, fn);
  const orderingTail = runPromise.then(() => {}, () => {});
  pathLocks.set(key, orderingTail);
  orderingTail.finally(() => {
    if (pathLocks.get(key) === orderingTail) pathLocks.delete(key);
  });
  return runPromise;
}

// ============ SECTION: backup ============
function findOwningRoot(realPath, config) {
  return (config.allowedRootsResolved || []).find((root) => isWithinRoot(root, realPath)) || null;
}

async function pruneBackups(dir, baseName, retention) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (e) {
    return;
  }
  const prefix = `${baseName}.`;
  const matches = entries.filter((f) => f.startsWith(prefix) && f.endsWith('.bak')).sort();
  const excess = matches.length - retention;
  if (excess > 0) {
    const toDelete = matches.slice(0, excess);
    await Promise.all(toDelete.map((f) => fsp.unlink(path.join(dir, f)).catch(() => {})));
  }
}

async function backupBeforeOverwrite(realPath, config) {
  let st;
  try {
    st = await fsp.stat(realPath);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  if (st.isDirectory()) return;

  const root = findOwningRoot(realPath, config);
  const relDir = root ? path.dirname(path.relative(root, realPath)) : path.dirname(realPath);
  const baseName = path.basename(realPath);
  const backupDirAbs = path.isAbsolute(config.backupDir) ? config.backupDir : path.join(getBaseDir(), config.backupDir);
  const targetDir = path.join(backupDirAbs, relDir === '.' ? '' : relDir);
  await fsp.mkdir(targetDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(targetDir, `${baseName}.${stamp}.bak`);
  await fsp.copyFile(realPath, backupPath);
  await pruneBackups(targetDir, baseName, config.backupRetention);
}

// ============ SECTION: rate limiting ============
function checkRateLimit(ip, config) {
  const { maxRequests, windowMs } = config.rateLimit;
  const now = Date.now();
  const key = ip || 'unknown';
  const timestamps = (rateLimitState.get(key) || []).filter((t) => now - t < windowMs);
  if (timestamps.length >= maxRequests) {
    rateLimitState.set(key, timestamps);
    return { allowed: false, retryAfterMs: Math.max(windowMs - (now - timestamps[0]), 0) };
  }
  timestamps.push(now);
  rateLimitState.set(key, timestamps);
  return { allowed: true };
}

// ============ SECTION: audit log ============
function summarizeParams(toolName, args) {
  if (!args) return null;
  switch (toolName) {
    case 'list_directory':
      return { path: args.path, recursive: !!args.recursive };
    case 'read_files':
      return { paths: (args.files || []).map((f) => (typeof f === 'string' ? f : f.path)) };
    case 'write_files':
      return { files: (args.files || []).map((f) => ({ path: f.path, contentLength: (f.content || '').length })) };
    case 'delete_files':
      return { paths: args.paths };
    case 'move_files':
    case 'copy_files':
      return { items: args.items };
    case 'search_files':
      return { rootPath: args.rootPath, namePattern: args.namePattern, contentPattern: args.contentPattern };
    case 'analyze_file':
      return { path: args.path };
    default:
      return null;
  }
}

function writeAuditLog(config, entry) {
  stats.totalRequests += 1;
  if (entry.success === false) stats.totalErrors += 1;
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
  const auditPath = path.isAbsolute(config.auditLogPath) ? config.auditLogPath : path.join(getBaseDir(), config.auditLogPath);
  fs.appendFile(auditPath, line, (err) => {
    if (err) console.error('[audit] failed to write audit log:', err.message);
  });
}

async function readRecentAuditEntries(config, limit) {
  const auditPath = path.isAbsolute(config.auditLogPath) ? config.auditLogPath : path.join(getBaseDir(), config.auditLogPath);
  let raw;
  try {
    raw = await fsp.readFile(auditPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const lines = raw.split('\n').filter(Boolean).slice(-limit);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch (e) {
      // skip malformed lines
    }
  }
  return entries;
}

function currentSourceIp() {
  const ctx = requestContext.getStore();
  return (ctx && ctx.sourceIp) || 'unknown';
}

function wrapToolHandler(toolName, handlerFn, config) {
  return async (args) => {
    try {
      const result = await handlerFn(args, config);
      writeAuditLog(config, { tool: toolName, paramsSummary: summarizeParams(toolName, args), success: true, sourceIp: currentSourceIp() });
      return result;
    } catch (err) {
      writeAuditLog(config, { tool: toolName, paramsSummary: summarizeParams(toolName, args), success: false, error: err.message, sourceIp: currentSourceIp() });
      return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  };
}

// ============ SECTION: directory walking / glob ============
async function walkDir(dir, recursive, maxDepth, currentDepth) {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const result = [];
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    let st;
    try {
      st = await fsp.stat(full);
    } catch (e) {
      result.push({ name: d.name, type: 'unknown', error: e.message });
      continue;
    }
    const item = {
      name: d.name,
      type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
      size: st.size,
      mtime: st.mtime.toISOString(),
    };
    if (st.isDirectory() && recursive) {
      if (currentDepth >= maxDepth) {
        item.truncated = true;
      } else {
        item.children = await walkDir(full, recursive, maxDepth, currentDepth + 1);
      }
    }
    result.push(item);
  }
  return result;
}

// namePattern matches against the file's basename only (not the full path),
// so only * and ? are meaningful — there is no path separator to anchor **.
function globToRegex(glob) {
  let re = '';
  for (const c of glob) {
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

async function readFileLines(realPath, startLine, endLine) {
  const from = startLine || 1;
  const to = endLine || Infinity;
  const collected = [];
  let lineNo = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(realPath, { encoding: 'utf8' }) });
  for await (const line of rl) {
    lineNo++;
    if (lineNo < from) continue;
    if (lineNo > to) break;
    collected.push(line);
  }
  rl.close();
  return { content: collected.join('\n'), startLine: from, endLine: to === Infinity ? lineNo : Math.min(to, lineNo) };
}

// ============ SECTION: tool handlers ============
async function handleListDirectory(args, config) {
  const { path: inputPath, recursive = false, maxDepth = 10 } = args;
  const { realPath } = resolveSafePath(inputPath, config);
  const st = await fsp.stat(realPath);
  if (!st.isDirectory()) throw new Error('path is not a directory');
  const entries = await walkDir(realPath, recursive, maxDepth, 0);
  return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
}

async function handleReadFiles(args, config) {
  const { files, startLine: globalStart, endLine: globalEnd } = args;
  const results = await Promise.all(files.map(async (item) => {
    const spec = typeof item === 'string' ? { path: item } : item;
    const startLine = spec.startLine ?? globalStart;
    const endLine = spec.endLine ?? globalEnd;
    try {
      const { realPath } = resolveSafePath(spec.path, config);
      assertExtensionAllowed(realPath, config);
      const st = await fsp.stat(realPath);
      if (st.isDirectory()) return { path: spec.path, error: 'path is a directory' };
      assertFileSizeOk(st.size, config);
      if (startLine || endLine) {
        const ranged = await readFileLines(realPath, startLine, endLine);
        return { path: spec.path, ...ranged };
      }
      const content = await fsp.readFile(realPath, 'utf8');
      return { path: spec.path, content };
    } catch (e) {
      return { path: spec.path, error: e.message };
    }
  }));
  return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
}

async function handleWriteFiles(args, config) {
  const { files } = args;
  const results = await Promise.all(files.map(async (f) => {
    try {
      const { realPath } = resolveSafePath(f.path, config);
      assertExtensionAllowed(realPath, config);
      const encoding = f.encoding || 'utf8';
      const buffer = encoding === 'base64' ? Buffer.from(f.content, 'base64') : Buffer.from(f.content, 'utf8');
      assertFileSizeOk(buffer.length, config);
      await withPathLock(realPath, async () => {
        if (await fileExists(realPath)) await backupBeforeOverwrite(realPath, config);
        await fsp.mkdir(path.dirname(realPath), { recursive: true });
        await fsp.writeFile(realPath, buffer);
      });
      return { path: f.path, ok: true };
    } catch (e) {
      return { path: f.path, ok: false, error: e.message };
    }
  }));
  return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
}

async function handleDeleteFiles(args, config) {
  const { paths } = args;
  const results = await Promise.all(paths.map(async (p) => {
    try {
      const { realPath } = resolveSafePath(p, config);
      assertExtensionAllowed(realPath, config);
      await withPathLock(realPath, async () => {
        const st = await fsp.stat(realPath).catch((e) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        });
        if (!st) throw new Error('file does not exist');
        if (st.isDirectory()) throw new Error('path is a directory, refusing to delete');
        await backupBeforeOverwrite(realPath, config);
        await fsp.unlink(realPath);
      });
      return { path: p, ok: true };
    } catch (e) {
      return { path: p, ok: false, error: e.message };
    }
  }));
  return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
}

async function handleTransferFiles(args, config, mode) {
  const { items } = args;
  const results = await Promise.all(items.map(async (item) => {
    try {
      const { realPath: fromReal } = resolveSafePath(item.from, config);
      const { realPath: toReal } = resolveSafePath(item.to, config);
      assertExtensionAllowed(fromReal, config);
      assertExtensionAllowed(toReal, config);
      const fromStat = await fsp.stat(fromReal);
      if (fromStat.isDirectory()) throw new Error('source is a directory, not supported');
      // Only the destination is lock-guarded: locking both ends would need a
      // fixed lock-ordering scheme to avoid A-waits-B/B-waits-A deadlocks.
      await withPathLock(toReal, async () => {
        if (await fileExists(toReal)) await backupBeforeOverwrite(toReal, config);
        await fsp.mkdir(path.dirname(toReal), { recursive: true });
        if (mode === 'move') {
          try {
            await fsp.rename(fromReal, toReal);
          } catch (e) {
            if (e.code === 'EXDEV') {
              await fsp.copyFile(fromReal, toReal);
              await fsp.unlink(fromReal);
            } else {
              throw e;
            }
          }
        } else {
          await fsp.copyFile(fromReal, toReal);
        }
      });
      return { from: item.from, to: item.to, ok: true };
    } catch (e) {
      return { from: item.from, to: item.to, ok: false, error: e.message };
    }
  }));
  return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
}

async function handleSearchFiles(args, config) {
  const { rootPath, namePattern, contentPattern, maxResults = 100 } = args;
  const { realPath: rootReal } = resolveSafePath(rootPath, config);
  const rootStat = await fsp.stat(rootReal);
  if (!rootStat.isDirectory()) throw new Error('rootPath is not a directory');

  const nameRegex = namePattern ? globToRegex(namePattern) : null;
  let contentRegex = null;
  if (contentPattern) {
    try {
      contentRegex = new RegExp(contentPattern);
    } catch (e) {
      contentRegex = new RegExp(contentPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
  }

  const matches = [];
  async function walk(dir) {
    if (matches.length >= maxResults) return;
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const d of dirents) {
      if (matches.length >= maxResults) return;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!d.isFile()) continue;
      if (nameRegex && !nameRegex.test(d.name)) continue;
      if (!contentRegex) {
        matches.push({ path: full, type: 'name' });
        continue;
      }
      let fileStat;
      try {
        fileStat = await fsp.stat(full);
      } catch (e) {
        continue;
      }
      if (fileStat.size > config.maxFileSizeBytes) continue;
      let content;
      try {
        content = await fsp.readFile(full, 'utf8');
      } catch (e) {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (contentRegex.test(lines[i])) {
          matches.push({
            path: full,
            type: 'content',
            lineNumber: i + 1,
            line: lines[i],
            contextBefore: lines.slice(Math.max(0, i - 2), i),
            contextAfter: lines.slice(i + 1, i + 3),
          });
        }
      }
    }
  }
  await walk(rootReal);
  return { content: [{ type: 'text', text: JSON.stringify(matches, null, 2) }] };
}

async function handleAnalyzeFile(args, config) {
  const { path: inputPath } = args;
  const { realPath } = resolveSafePath(inputPath, config);
  assertExtensionAllowed(realPath, config);
  const st = await fsp.stat(realPath);
  if (st.isDirectory()) throw new Error('path is a directory');
  assertFileSizeOk(st.size, config);

  const buffer = await fsp.readFile(realPath);
  const encoding = guessEncoding(buffer);
  const ext = path.extname(realPath).toLowerCase();
  const language = EXT_LANGUAGE_MAP[ext] || 'unknown';

  let lineCount = null;
  let functionCount = null;
  let classCount = null;
  if (encoding !== 'binary') {
    const text = buffer.toString('utf8');
    lineCount = text.length ? text.split('\n').length : 0;
    const patterns = FUNCTION_PATTERNS[language];
    if (patterns) {
      functionCount = patterns.fn.reduce((sum, re) => sum + (text.match(re) || []).length, 0);
      classCount = patterns.cls.reduce((sum, re) => sum + (text.match(re) || []).length, 0);
    }
  }

  const result = {
    path: inputPath,
    size: st.size,
    mtime: st.mtime.toISOString(),
    encoding,
    extension: ext,
    language,
    lineCount,
    functionCount,
    classCount,
    analysisNote: 'function/class counts are heuristic regex-based estimates, not AST-accurate parsing',
  };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

// ============ SECTION: tool schemas + registration ============
function buildToolSchemas() {
  const fileRef = z.union([
    z.string(),
    z.object({
      path: z.string(),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
    }),
  ]);
  return {
    list_directory: {
      path: z.string().describe('Absolute path of the directory to list'),
      recursive: z.boolean().optional().default(false).describe('Recurse into subdirectories'),
      maxDepth: z.number().int().positive().optional().default(10).describe('Max recursion depth when recursive=true'),
    },
    read_files: {
      files: z.array(fileRef).min(1).describe('Files to read; plain string or {path, startLine, endLine} (1-based, inclusive)'),
      startLine: z.number().int().positive().optional().describe('Default start line (1-based) for entries without their own'),
      endLine: z.number().int().positive().optional().describe('Default end line (1-based, inclusive)'),
    },
    write_files: {
      files: z.array(z.object({
        path: z.string(),
        content: z.string(),
        encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
      })).min(1),
    },
    delete_files: {
      paths: z.array(z.string()).min(1).describe('Only regular files are deletable, not directories'),
    },
    move_files: {
      items: z.array(z.object({ from: z.string(), to: z.string() })).min(1),
    },
    copy_files: {
      items: z.array(z.object({ from: z.string(), to: z.string() })).min(1),
    },
    search_files: {
      rootPath: z.string(),
      namePattern: z.string().optional().describe('Glob against the filename only, supports * and ?'),
      contentPattern: z.string().optional().describe('Regex; falls back to a literal substring match if invalid as regex'),
      maxResults: z.number().int().positive().optional().default(100),
    },
    analyze_file: {
      path: z.string(),
    },
  };
}

function registerTools(server, config) {
  const schemas = buildToolSchemas();

  server.registerTool(
    'list_directory',
    { description: 'List directory contents (name/type/size/mtime), optionally recursive.', inputSchema: schemas.list_directory },
    wrapToolHandler('list_directory', handleListDirectory, config)
  );
  server.registerTool(
    'read_files',
    { description: 'Read one or more files, optionally by 1-based line range.', inputSchema: schemas.read_files },
    wrapToolHandler('read_files', handleReadFiles, config)
  );
  server.registerTool(
    'write_files',
    { description: 'Write/create one or more files. Overwriting an existing file is backed up first.', inputSchema: schemas.write_files },
    wrapToolHandler('write_files', handleWriteFiles, config)
  );
  server.registerTool(
    'delete_files',
    { description: 'Delete one or more files (not directories). Backed up first.', inputSchema: schemas.delete_files },
    wrapToolHandler('delete_files', handleDeleteFiles, config)
  );
  server.registerTool(
    'move_files',
    { description: 'Move/rename one or more files. Existing destination files are backed up first.', inputSchema: schemas.move_files },
    wrapToolHandler('move_files', (a, c) => handleTransferFiles(a, c, 'move'), config)
  );
  server.registerTool(
    'copy_files',
    { description: 'Copy one or more files. Existing destination files are backed up first.', inputSchema: schemas.copy_files },
    wrapToolHandler('copy_files', (a, c) => handleTransferFiles(a, c, 'copy'), config)
  );
  server.registerTool(
    'search_files',
    { description: 'Search files by filename glob and/or file content (regex or literal substring).', inputSchema: schemas.search_files },
    wrapToolHandler('search_files', handleSearchFiles, config)
  );
  server.registerTool(
    'analyze_file',
    { description: 'Basic file stats plus a heuristic function/class count estimate.', inputSchema: schemas.analyze_file },
    wrapToolHandler('analyze_file', handleAnalyzeFile, config)
  );
}

function createMcpServer(config) {
  const server = new McpServer({ name: 'cc-bridge', version: VERSION });
  registerTools(server, config);
  return server;
}

// ============ SECTION: UI asset ============
function loadUiHtml() {
  try {
    const sea = require('node:sea');
    if (sea.isSea && sea.isSea()) {
      return sea.getAsset('ui.html', 'utf8');
    }
  } catch (e) {
    // 'node:sea' unavailable or not running as SEA — fall through to disk.
  }
  return fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
}

// ============ SECTION: HTTP plumbing ============
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function authenticate(req, config) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  return timingSafeEqualStr(match[1], config.token);
}

function getLanIps() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

function buildConnectCommand(config, ip) {
  return `claude mcp add --transport http cc-bridge http://${ip}:${config.port}/mcp --header "Authorization: Bearer ${config.token}"`;
}

function printStartupBanner(config) {
  const ips = getLanIps();
  console.error(`cc-bridge v${VERSION} listening on http://${config.host}:${config.port}/mcp`);
  console.error(`Web panel:                    http://${ips[0] || '127.0.0.1'}:${config.port}/`);
  if (ips.length === 0) {
    console.error('未检测到局域网 IPv4 地址，请手动确认本机 IP 后替换下面命令中的 <本机IP>:');
    console.error('  ' + buildConnectCommand(config, '<本机IP>'));
  } else if (ips.length === 1) {
    console.error('远程 Claude Code 侧执行以下命令即可添加此 MCP server:');
    console.error('  ' + buildConnectCommand(config, ips[0]));
  } else {
    console.error('检测到多个网卡 IP，请选择远程服务器实际可达的那个:');
    ips.forEach((ip) => console.error('  ' + buildConnectCommand(config, ip)));
  }
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sendJsonRpcError(res, httpCode, message) {
  res.writeHead(httpCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function sendUnauthorized(res, config, toolLabel, sourceIp) {
  writeAuditLog(config, { tool: toolLabel, success: false, error: 'auth_failed', sourceIp });
  sendJson(res, 401, { error: 'unauthorized' });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    const MAX_BODY_BYTES = 1024 * 1024;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function createHttpServer(config, uiHtml) {
  return http.createServer((req, res) => {
    const sourceIp = req.socket.remoteAddress || 'unknown';
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (e) {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }
    const pathName = parsedUrl.pathname;

    if (pathName === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok', version: VERSION });
      return;
    }

    if (pathName === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(uiHtml);
      return;
    }

    if (pathName === '/status' && req.method === 'GET') {
      if (!authenticate(req, config)) return sendUnauthorized(res, config, 'status', sourceIp);
      const ips = getLanIps();
      sendJson(res, 200, {
        status: 'ok',
        version: VERSION,
        uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
        allowedRoots: config.allowedRoots,
        allowedExtensions: config.allowedExtensions,
        maxFileSizeBytes: config.maxFileSizeBytes,
        rateLimit: config.rateLimit,
        backupRetention: config.backupRetention,
        host: config.host,
        port: config.port,
        stats: { totalRequests: stats.totalRequests, totalErrors: stats.totalErrors },
        connectCommand: buildConnectCommand(config, ips[0] || '127.0.0.1'),
      });
      return;
    }

    if (pathName === '/audit/recent' && req.method === 'GET') {
      if (!authenticate(req, config)) return sendUnauthorized(res, config, 'audit_recent', sourceIp);
      const limit = Math.min(Math.max(parseInt(parsedUrl.searchParams.get('limit') || '50', 10) || 50, 1), 500);
      readRecentAuditEntries(config, limit)
        .then((entries) => sendJson(res, 200, entries))
        .catch((e) => sendJson(res, 500, { error: e.message }));
      return;
    }

    if (pathName === '/fs/browse' && req.method === 'GET') {
      if (!authenticate(req, config)) return sendUnauthorized(res, config, 'fs_browse', sourceIp);
      const target = parsedUrl.searchParams.get('path') || '';
      browseDirectory(target)
        .then((result) => sendJson(res, 200, result))
        .catch((e) => sendJson(res, 400, { error: e.message }));
      return;
    }

    if (pathName === '/config' && req.method === 'POST') {
      if (!authenticate(req, config)) return sendUnauthorized(res, config, 'config_update', sourceIp);
      readJsonBody(req)
        .then((patch) => {
          const result = validateAndApplyConfigPatch(config, patch);
          writeAuditLog(config, { tool: 'config_update', paramsSummary: { changed: result.changed || Object.keys(result.errors || {}) }, success: result.ok, error: result.ok ? undefined : 'validation_failed', sourceIp });
          sendJson(res, result.ok ? 200 : 400, result);
        })
        .catch((e) => sendJson(res, 400, { ok: false, error: e.message }));
      return;
    }

    if (pathName === '/config/token/regenerate' && req.method === 'POST') {
      if (!authenticate(req, config)) return sendUnauthorized(res, config, 'token_regenerate', sourceIp);
      const newToken = regenerateToken(config);
      writeAuditLog(config, { tool: 'token_regenerate', success: true, sourceIp });
      sendJson(res, 200, { ok: true, token: newToken });
      return;
    }

    if (pathName === '/mcp') {
      if (req.method !== 'POST') {
        sendJsonRpcError(res, 405, 'Method not allowed.');
        return;
      }
      if (!authenticate(req, config)) return sendUnauthorized(res, config, 'mcp', sourceIp);
      const rl = checkRateLimit(sourceIp, config);
      if (!rl.allowed) {
        writeAuditLog(config, { tool: 'N/A', success: false, error: 'rate_limited', sourceIp });
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) });
        res.end(JSON.stringify({ error: 'rate limited', retryAfterMs: rl.retryAfterMs }));
        return;
      }
      requestContext.run({ sourceIp }, async () => {
        const server = createMcpServer(config);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res);
          res.on('close', () => {
            transport.close();
            server.close();
          });
        } catch (err) {
          console.error('[mcp] request failed:', err.message);
          if (!res.headersSent) sendJsonRpcError(res, 500, 'Internal server error');
          transport.close();
          server.close();
        }
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });
}

// ============ SECTION: --setup wizard ============
async function runSetupWizard() {
  console.log('=== cc-bridge 配置向导 ===');
  let cfg;
  let isNew = false;
  if (fs.existsSync(CONFIG_PATH)) {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } else {
    cfg = defaultConfig();
    isNew = true;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // A single shared async iterator (not rl.question()) reads every line, so
  // lines already buffered by a non-TTY input (e.g. piped/scripted input)
  // can never be silently dropped between prompts.
  const lineIterator = rl[Symbol.asyncIterator]();
  async function nextLine(prompt) {
    if (prompt) process.stdout.write(prompt);
    const { value, done } = await lineIterator.next();
    return done ? '' : value;
  }

  console.log('请输入允许 Claude Code 访问的根目录（每行一个绝对路径，输入空行结束）:');
  const roots = [];
  for (;;) {
    const line = (await nextLine('> ')).trim();
    if (!line) break;
    if (!fs.existsSync(line)) {
      const confirm = (await nextLine(`目录不存在: ${line}，仍要添加吗? (y/N) `)).trim().toLowerCase();
      if (confirm !== 'y') continue;
    }
    roots.push(path.resolve(line));
  }
  if (roots.length) cfg.allowedRoots = roots;

  const portInput = (await nextLine(`监听端口 (当前 ${cfg.port}，回车保持不变): `)).trim();
  if (portInput) {
    const p = parseInt(portInput, 10);
    if (Number.isInteger(p) && p > 0) cfg.port = p;
  }

  rl.close();
  persistConfigToDisk(cfg);
  console.log(`配置已${isNew ? '创建' : '更新'}: ${CONFIG_PATH}`);

  const finalCfg = finalizeConfig(cfg);
  const ips = getLanIps();
  console.log('');
  console.log('远程 Claude Code 侧执行以下命令即可添加此 MCP server:');
  console.log('  ' + buildConnectCommand(finalCfg, ips[0] || '<本机IP>'));
  console.log('');
  console.log('配置完成，运行 "node cc-bridge.js" 启动服务。');
}

// ============ SECTION: main ============
async function main() {
  if (process.argv.includes('--setup')) {
    await runSetupWizard();
    return;
  }

  const config = loadOrInitConfig();
  const uiHtml = loadUiHtml();
  const httpServer = createHttpServer(config, uiHtml);
  httpServer.listen(config.port, config.host, () => {
    printStartupBanner(config);
  });
}

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
