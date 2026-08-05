# -*- coding: utf-8 -*-
"""
纯搬动重构的等价性校验器。
思路：Rust 顶层项一定从第 0 列开始，所以按「列 0 出现的项」切块即可，不需要写花括号匹配。
每块规范化（去尾随空白、压掉纯空行）后算 md5：
  - 搬动只改变块的**所在文件与顺序**，不改变块内容 → 哈希集合必须逐字相同
  - 任何一处逻辑被改动 → 该块哈希变化，立刻暴露
用法：
  baseline: python fingerprint.py commands.rs            > before.txt
  after   : python fingerprint.py commands/*.rs          > after.txt
  比对    : diff before.txt after.txt   （必须为空）
"""
import sys, io, re, hashlib, glob

# 顶层项开头：列 0 的 fn/struct/enum/const/static/impl/mod/type/use/属性/文档注释
# 注意 `//` 必须在列表里：列 0 的普通注释（如 `// ===== 自动更新 =====` 这种区段分隔）
# 若不算作块起点，就会被并进**前一个函数**的块里——搬动时这行注释跟着走，
# 相邻函数的哈希便无故变化，产生假警报。2026-08-05 第一次跑就踩到了这个。
ITEM = re.compile(
    r'^(?:#\[|#!\[|//|pub\s|fn\s|async\s|unsafe\s|struct\s|enum\s|const\s|static\s|'
    r'impl[\s<]|mod\s|type\s|use\s|extern\s|macro_rules!)')

def blocks(path):
    lines = io.open(path, encoding='utf-8').read().split('\n')
    cuts = [i for i, l in enumerate(lines) if l and not l[0].isspace() and ITEM.match(l)]
    out = []
    for k, i in enumerate(cuts):
        end = cuts[k + 1] if k + 1 < len(cuts) else len(lines)
        out.append(lines[i:end])
    return out

def name_of(blk):
    """取块的标识：属性/注释行跳过，找到真正的声明行。"""
    for l in blk:
        s = l.strip()
        if s.startswith('#[') or s.startswith('//') or not s:
            continue
        m = re.search(r'\b(?:fn|struct|enum|const|static|type|mod)\s+([A-Za-z_][A-Za-z0-9_]*)', s)
        if m:
            return m.group(1)
        if s.startswith('impl'):
            return 'impl:' + re.sub(r'\s+', ' ', s)[:60]
        if s.startswith('use '):
            return None          # imports 允许变化（拆分后每文件各自最小化）
        return re.sub(r'\s+', ' ', s)[:60]
    return None

def norm(blk):
    """规范化：去尾随空白、丢纯空行。刻意**不**动缩进与顺序——那才是逻辑。"""
    body = [l.rstrip() for l in blk]
    return '\n'.join([l for l in body if l.strip() != ''])

rows = []
for pat in sys.argv[1:]:
    for path in sorted(glob.glob(pat)):
        for blk in blocks(path):
            n = name_of(blk)
            if n is None:
                continue
            # cfg 属性要并入标识：同名函数的 windows / 非 windows 两版必须各自比对
            cfg = ''.join(sorted(l.strip() for l in blk if l.strip().startswith('#[cfg')))
            key = n + ('|' + hashlib.md5(cfg.encode()).hexdigest()[:6] if cfg else '')
            rows.append('%-58s %s' % (key, hashlib.md5(norm(blk).encode('utf-8')).hexdigest()))

for r in sorted(rows):
    print(r)
print('# total items: %d' % len(rows))
