# cc-bridge — Install it where your files live; connect AI from anywhere

[![Latest release](https://img.shields.io/github/v/release/lzlkyb/cc-bridge)](https://github.com/lzlkyb/cc-bridge/releases)
[![License](https://img.shields.io/github/license/lzlkyb/cc-bridge)](LICENSE)
[![Stars](https://img.shields.io/github/stars/lzlkyb/cc-bridge)](https://github.com/lzlkyb/cc-bridge/stargazers)
[![Downloads](https://img.shields.io/github/downloads/lzlkyb/cc-bridge/total)](https://github.com/lzlkyb/cc-bridge/releases)

> **中文** | [README.md](README.md)（更详细，含架构细节与部署流程）

**cc-bridge** is a **bidirectional MCP bridge** — a native desktop app (Windows / macOS, Tauri 2 + Rust) that you install **on the machine where your files live**. Any MCP-capable AI client — Claude Code, Codex, WorkBuddy, or any generic MCP client — can then connect to it from anywhere and work on those files with full protection: path whitelist, audit log, automatic backups, one-click restore.

Installer size: **4.5 MB** (Windows) / **5.7 MB** (macOS).

## Two modes, one app

| | **Mode A** — remote AI → local files | **Mode B** — local AI → remote files |
|---|---|---|
| Where the AI runs | Remote Linux server (VPS, cluster) | Your laptop / local machine |
| Where the files live | Your local Windows / macOS | Another Windows / macOS box (home desktop, office machine) |
| Network | Same LAN / VPN (HTTP + Bearer) | Across the internet (**built-in self-signed HTTPS**, or reverse proxy + Let's Encrypt) |
| Typical story | "Claude Code on my VPS edits the repo on my Windows workstation — no more scp / SSHFS." | "My cloud Codex works on the toolchain that only exists on my office Windows machine." |

> The rule is simple: **install the bridge where the files are; the AI connects from the other side.** Both directions use the same installer, the same port, and the same security model.

## Quick start (~1 minute)

**Step 1 (both modes)** — download and install on **the machine where the files live**, from [Releases](https://github.com/lzlkyb/cc-bridge/releases):

| OS | Download | Install |
|---|---|---|
| **Windows 10/11** | `cc-bridge_x.x.x_x64-setup.exe` | Run the installer |
| **macOS** (Apple Silicon) | `cc-bridge_x.x.x_aarch64-apple-darwin.zip` | Unzip into Applications; first launch is blocked by Gatekeeper — see the [macOS notes in the Chinese README](README.md#macos-安装与更新说明) |

> Intel Mac (x86_64) and Linux builds are not available yet.

**Step 2** — open the **Security** page and add your working directories to the path whitelist (default: deny everything).

### Mode A: remote AI → local files (same LAN / VPN)

3. On the **Connect** page, copy the generated command and run it on the remote Linux box:

   ```bash
   claude mcp add --transport http cc-bridge http://<LAN-IP>:7823/mcp --header "Authorization: Bearer <token>"
   ```

4. Done — the remote Claude Code can now read, search, and edit your local files.

### Mode B: local AI → remote files (across the internet)

3. In **Settings › Security › HTTPS remote access**, enable HTTPS with one click — a self-signed certificate is generated (bound to all NIC IPs), and a **SHA-256 fingerprint** is displayed.
4. On **the machine running the bridge**, open the Connect page wizard, pick your AI tool, and copy the snippet — URLs switch to `https://` automatically; then carry the URL and token over to your local AI tool's config.
5. **Verify the fingerprint** between the settings page and your local copy of the cert (man-in-the-middle protection).
6. Wire it into your tool: Claude Code (CLI + `NODE_EXTRA_CA_CERTS`), Codex (`~/.codex/config.toml`, TOML), WorkBuddy (`~/.workbuddy/mcp.json`, JSON), or any MCP client (bare URL + headers). Details: [client compatibility matrix](docs/client-compatibility.md).

> Public-internet guardrails: strong-token enforcement when remote access is on, automatic IP ban after repeated 401s (default 5 → 15 min), fail-closed path whitelist. With a domain, prefer a reverse proxy + Let's Encrypt — templates in [reverse-proxy.md](docs/reverse-proxy.md).

## Architecture

```
Mode A                                Mode B
┌──────────────────────┐             ┌────────────────────────────┐
│ Remote Linux (Claude Code) │       │ Laptop (Claude Code/Codex) │
└──────────┬───────────┘             └──────────┬─────────────────┘
           │ MCP / HTTP (LAN/VPN)               │ MCP / HTTPS (self-signed or proxy)
           ▼                                    ▼
┌─────────────────────────────────────────────────────────────┐
│  The machine with the files (Windows / macOS)               │
│  └─ cc-bridge ── single-process Tauri 2 desktop app         │
│       ├─ Embedded axum HTTP(S) server ── MCP JSON-RPC       │
│       │        + 20 tools + validation + backups + rate     │
│       │          limiting + 401 ban + audit log            │
│       ├─ SQLite config store (atomic updates)               │
│       └─ React frontend (Tauri IPC, management panel)       │
└─────────────────────────────────────────────────────────────┘
```

Key decisions: pure-Rust backend compiled into the Tauri binary (no Node sidecar), axum embedded in the Tauri process exposing the MCP port, frontend talks over Tauri IPC only (the token is for remote clients), SQLite instead of config.json, append-only JSONL audit log.

## What the AI gets: 20 MCP tools

File operations: `list_allowed_roots` (discover the whitelist), `list_directory`, `read_files` (batch, line ranges, encoding detection incl. GBK→UTF-8), `write_files` (auto-backup before overwrite), `edit_files` (unique-match string replace, preserves encoding), `notebook_edit` (Jupyter), `delete_files`, `move_files`, `copy_files`, `create_directory`, `remove_directory`, `search_files` (glob + content/regex), `analyze_file` (encoding + language + heuristic symbol counts).

Efficiency & control: `batch` (N tool calls in one round trip), `run_command` (shell, **off by default**; foreground or background), `get_command_output` (incremental stdout/stderr pull), `stop_command` (kills the whole process tree), `push_notification` (desktop notification, optional compile-time feature).

External MCP bridging: `mcp_list_servers` (list bridged external MCP servers + their tools), `mcp_proxy` (invoke a tool on an external server — ⚠️ separate process, **not** constrained by the path whitelist, blocked entirely in read-only mode).

## Security model

- **Path whitelist** — canonicalize + ancestor traversal checks; symlink escape and path traversal rejected; error messages include the current whitelist so the AI never guesses.
- **Bearer token** — constant-time comparison, 32-char random.
- **Rate limiting** — sliding window (default 100 req/min → 429).
- **401 ban** — repeated auth failures ban the source IP (default 5 → 15 min) when remote access is on.
- **Automatic backups** — before every write/delete/overwrite, timestamped, auto-pruned.
- **Audit log** — every call with tool, params, result, source IP, duration; retention configurable (default 30 days).
- **Transport** — HTTP + Bearer for trusted LAN/VPN only; built-in **self-signed HTTPS** (fingerprint verification advised) or reverse proxy + Let's Encrypt for the public internet. Defaults are conservative: remote access off until explicitly enabled, fail-closed whitelist, command execution off.

## Built-in SSH terminal (for humans, not the AI)

The 5th tab is a real interactive SSH terminal (system OpenSSH + PTY + xterm.js): password or key auth (credentials encrypted at rest with aes-gcm), multi-tab sessions with keepalive, and an SFTP drawer (browse/upload/download/mkdir/delete). It goes over local Tauri IPC only — remote AI clients cannot touch it.

## Tech stack

| Layer | Tech |
|---|---|
| Desktop framework | Tauri 2 (system WebView: WebView2 / WKWebView) |
| Backend | Rust, axum 0.8, tokio |
| Config store | SQLite (rusqlite bundled) |
| PTY | portable-pty 0.9 (ConPTY / Unix pty) |
| Crypto | subtle 2 (constant-time), aes-gcm 0.10, rand 0.8 |
| TLS | rustls + rcgen (self-signed), axum-server |
| Frontend | React 18 + TypeScript + Vite 6, TailwindCSS 4, TanStack Query 5 |
| Terminal | xterm.js 5 |
| Packaging | NSIS (Windows), `.app` + zip (macOS) |
| Platforms | Windows 10/11, macOS (Apple Silicon) |

## Known limitations

- Windows 10/11 and macOS (Apple Silicon) only — no Intel Mac or Linux builds yet.
- Public-internet access is supported only via the built-in self-signed HTTPS or a reverse proxy + Let's Encrypt; no built-in tunneling/NAT traversal, and plain HTTP must not be exposed publicly.
- Self-signed-certificate compatibility varies by client — see the [honest compatibility matrix](docs/client-compatibility.md) instead of promises.
- `analyze_file` uses regex heuristics, not a parser. `delete_files` only deletes single files, not directories (by design).
- MCP is implemented as manual JSON-RPC dispatch (no rmcp SDK macros, no protocol negotiation).

## Docs (Chinese, more detailed)

- [架构 / 交互流程 / 部署流程](README.md)
- [Client compatibility matrix](docs/client-compatibility.md)
- [Reverse proxy templates (Caddy / nginx)](docs/reverse-proxy.md)
- [Security review of all MCP tools](docs/MCP工具安全审查报告-2026-07-12.md)

## License

See [LICENSE](LICENSE).
