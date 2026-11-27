# 踩坑清单

下面每一条都在 Windows 主机的当前版本上实测过。

## 行尾与编码

- `edit_files` 的旧文本和新文本一律用 `\n` 换行。工具在归一化为 LF 的文本上工作，回写时按文件原有行尾还原：CRLF 文件改完仍是 CRLF。新文本里带 `\r` 会被直接拒绝。
- GBK 等非 UTF-8 文件：`edit_files` 传 `encoding:"gbk"`，编码和 CRLF 都会保留；不传则按 UTF-8 读。
- `search_files` 按 UTF-8 字节匹配：GBK 文件里的中文不传 `encoding:"gbk"` 就搜不到。空结果不能当作「不存在」的结论（工具在未命中时会提示这一点）。

## 在命令里写文件

- Git Bash 没有 `iconv`，用它做转码什么也转不了。
- 重定向会先清空目标：`cmd < f > f`、`cmd f > f` 在命令开始前就把 `f` 截成 0 字节，原内容丢失。不要把输出重定向到正在读的文件；改写用 `edit_files`，或用 Python 先读入内存再写。
- Python 在 Windows 上以文本模式写文件会把 `\n` 写成 `\r\n`，整份文件的行尾都被改成 CRLF。要保持 LF 用 `open(path, "w", newline="")`，或直接用 `edit_files` / `write_files`。

## 路径

- 文件类工具只认服务端配置的「允许根目录」；白名单外（例如系统临时目录）会返回 `Access denied ... is not within any allowed root`。临时文件放在白名单内的目录里，用完删除。
