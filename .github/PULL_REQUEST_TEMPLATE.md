## 改了什么

<!-- 一段话说清改动本身，不用复述 diff -->

## 为什么

<!-- 解决什么问题；关联的 issue 用 #123 -->

## 验证

- [ ] `npm run check` 通过（前端四项：体量 / eslint / tsc / vitest）
- [ ] `npm run check:rust` 通过（fmt / clippy / test）
- [ ] 实机跑过（说明跑了什么操作）
- [ ] UI 改动附截图或录屏

> Rust 侧没跑的话写清原因（例如本机是 GNU 工具链），CI 会兜底。

## 影响面

- 平台：<!-- Windows / macOS / 两者 -->
- 是否触及：
  - [ ] 安全模块（路径白名单 / Bearer token / 限流）
  - [ ] MCP 工具注册表（`mcp/tools/registry.rs`）
  - [ ] SSH 终端或端口转发
  - [ ] CI / 发版脚本

## 备注

<!-- 已知边界、故意没做的部分、需要维护者决定的事项 -->
