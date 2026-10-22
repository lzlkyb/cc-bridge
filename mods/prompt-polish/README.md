# prompt-polish（Claude Code mod）

读输入框里**还没提交**的草稿 → 模型改写 → 回填输入框，回车仍由你自己按。

## 为什么是 mod，不是在终端外壳里做浮层

| | 终端外壳（cc-bridge 自绘） | 本 mod |
|---|---|---|
| 取草稿 | 键位镜像 / 选区 / 手输，三层降级，还要处理 SGR 鼠标报告、历史召回 | `$.prompt.read()` |
| 回填 | `DEL × N` 或 `Ctrl+C` 清行（后者会打断正在跑的回合） | `$.prompt.fill(text)` |
| 算力 | 另起 `claude -p` 子进程：冷启动 2–8s、非交互 shell 的 PATH/鉴权 | `$.model.complete()`，计费到当前方案，不起进程 |

## 要求

- Claude Code **≥ v2.1.287**（mods 在终端默认开启）。`claude --version` 自查。
- 远端需要能写 `~/.claude/`（或用一个 `--plugin-dir` 的临时目录）。

## 安装

**试用（临时，不改任何配置）**

```bash
scp -r prompt-polish user@host:~/
ssh user@host
claude --plugin-dir ~/prompt-polish
```

**常驻（自动加载）**

```bash
mkdir -p ~/.claude/skills
cp -r ~/prompt-polish ~/.claude/skills/prompt-polish
```

下次启动 Claude Code 会以 `prompt-polish@skills-dir` 自动加载。卸载 = 删掉那个目录。

## 用法

| 命令 | 作用 |
|---|---|
| `/polish` | 打开面板：显示原文与改写结果，可 回填 / 复制 / 重来 / 放弃 |
| `/polish-probe` | 自省：打印 `$.prompt.read` / `$.prompt.fill` 的真实返回形状与往返结果 |

面板快捷键：`a` 回填、`c` 复制、`r` 重来、`q` 放弃、`Esc` 关闭。

## 权限边界（分发前必须保持）

本 mod 只调用：

```
$.command.register   $.prompt.read   $.prompt.fill
$.model.complete     $.ui.*（open / close / resolve / invalidate / toast / copy）
```

**不碰** `$.fs` / `$.http` / `$.process` / `$.env` / `$.mcp`。mod 不在沙箱里运行、以你的用户权限执行，所以这条边界要能一行行读出来验证：

```bash
claude plugin validate ./prompt-polish
# 会打印 hooks: 与 calls: 两行，calls 里应该只有上面那几项
```

## 自测（离线，不花钱，不用网络）

```bash
claude plugin validate ./prompt-polish    # 静态规则 + 它会列出认得的 calls
claude plugin test     ./prompt-polish    # 跑 hooks/*.test.ts，0.2s
```

## 已验证 / 未验证

已经跑通的（`claude --debug-file` 真实会话日志）：

```
hooks module prompt-polish@inline loaded ... events: prompt.edit,prompt.change,session.start,command.run,ui.render
plugin.register: prompt-polish ... admitted
$.command.register (prompt-polish): /polish listed
$.command.register (prompt-polish): /polish-probe listed
```

即：插件结构、`modules` 键、`register(on)`、`prompt.edit` 订阅、命令注册全部生效。

**还没验证的（要交互式终端，我这边跑不了）：**

- **`$.prompt.read()` 大概率不存在。** 离线 `claude plugin test` 拿到的 `$.prompt` 方法表是
  `submit|fill|edit|change|autocomplete|suggest|section|context|attachment|mention|compose`，
  **没有 `read`**。所以代码是双路径：先试 `$.prompt.read()`，抛错就用 `prompt.edit` 缓存。
  `/polish-probe` 的第一行会告诉你真实情况。
- `$.prompt.fill()` 的往返效果（回填后光标位置、是否触发重绘）。
- `$.model.complete()` 的返回字段（代码兼容 `string` 与 `{ text | content | output }`，并检查 `isAnswered === false`）。
- `Pane` 在窄终端的退化形态；面板里的按钮能否在你的终端里点中。

⚠️ 注意：`claude plugin validate` 的 `calls:` 列表**不是**「这些 API 可调用」的证明——
它接受了 `$.prompt.read`，而运行时并不认这个方法。以 `/polish-probe` 的实际输出为准。
