#!/usr/bin/env bash
# 批 C：图片输入协议探针（2026-10-26）
#
# 判定「stream-json 输入的 user message 能不能带图片」。
#
# ## 为什么不打真 API
#
# 第一次尝试是真链路，被环境挡住：`agentrouter.org`（用户 settings.json 里的中转站）
# 直连 TCP 不通，走 7897 代理可达但返回 503 server_error。而且真 API 只能看到
# 「模型答得对不对」，看不到「CLI 究竟把什么发给了 API」。
#
# 所以改用**本地假服务器**：把 `ANTHROPIC_BASE_URL` 指到 127.0.0.1，CLI 照常跑，
# 请求体原文落盘。这比真 API 更硬——能看到 image block 是不是被原样转发、
# base64 有没有被重新编码、media_type 会不会被改写。
#
# ## 必须用 `--settings` 覆盖
#
# 🔴 `~/.claude/settings.json` 的 `env` 段**优先于进程环境变量**：直接
#    `ANTHROPIC_BASE_URL=... claude ...` 会被 settings.json 里的值盖回去（实测三次
#    请求全打到 agentrouter，本地服务器一条都没收到）。用 `--settings <file>` 传一个
#    临时覆盖层才不会动用户配置（红线：不改用户 settings.json）。
#
# 用法：bash tools/图片输入探针-2026-10-26.sh
set -u
cd "$(dirname "$0")/.." || exit 1

PY=py
command -v py >/dev/null 2>&1 || PY=python
CLAUDE=$(command -v claude || echo "/c/Users/19145/AppData/Roaming/npm/claude")
[ -x "$CLAUDE" ] || { echo "找不到 claude，先确认 CLI 装好"; exit 1; }

TMP=.workbuddy/tmp
mkdir -p "$TMP"
cd "$TMP" || exit 1
rm -f probe-req.log

echo "== 1. 造一张可判定的测试图（红/绿/蓝三段竖条）=="
"$PY" - <<'PYEOF'
from PIL import Image, ImageDraw
import base64, json
im = Image.new('RGB', (300, 100), (255, 255, 255))
d = ImageDraw.Draw(im)
d.rectangle([0, 0, 49, 99], fill=(220, 40, 40))
d.rectangle([50, 0, 149, 99], fill=(40, 160, 60))
d.rectangle([150, 0, 299, 99], fill=(40, 70, 210))
im.save('probe-img.png')
b64 = base64.b64encode(open('probe-img.png', 'rb').read()).decode()
cases = {
    'base64': [{'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': b64}},
               {'type': 'text', 'text': '这图从左到右几块竖条？各是什么颜色？'}],
    'url': [{'type': 'image', 'source': {'type': 'url', 'url': 'https://example.com/a.png'}},
            {'type': 'text', 'text': 'hi'}],
    'wrong_type': [{'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/bmp', 'data': b64}},
                   {'type': 'text', 'text': 'hi'}],
}
for name, content in cases.items():
    with open(f'probe-{name}.ndjson', 'w', encoding='utf-8') as f:
        f.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': content}}) + '\n')
json.dump({'env': {'ANTHROPIC_BASE_URL': 'http://127.0.0.1:8899',
                   'ANTHROPIC_AUTH_TOKEN': 'probe-token',
                   'ANTHROPIC_MODEL': 'probe-model',
                   'API_TIMEOUT_MS': '30000'}},
          open('probe-settings.json', 'w', encoding='utf-8'), indent=1)
print('ok: probe-img.png + 3 个 case')
PYEOF

echo "== 2. 起假服务器（127.0.0.1:8899）=="
"$PY" ../../tools/图片探针假服务器-2026-10-26.py 8899 probe-req.log > probe-srv.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 2
curl -s -o /dev/null -w '  server=%{http_code}\n' --max-time 5 -X POST http://127.0.0.1:8899/v1/messages -d '{"warmup":1}'
: > probe-req.log   # 丢掉这次 warmup

for c in base64 url wrong_type; do
  echo "== case: $c =="
  NO_PROXY='127.0.0.1,localhost' no_proxy='127.0.0.1,localhost' \
    timeout 90 "$CLAUDE" --settings probe-settings.json \
    --print --input-format stream-json --output-format stream-json --verbose \
    < "probe-$c.ndjson" > "probe-$c.out" 2> "probe-$c.err"
  "$PY" - "$c" <<'PYEOF'
import json, os, sys
c = sys.argv[1]
if not (os.path.exists('probe-req.log') and os.path.getsize('probe-req.log')):
    print('  ✗ 没有请求到达本地服务器')
    sys.exit()
v = json.loads(open('probe-req.log', encoding='utf-8').read().splitlines()[0])
found = False
for m in v['body'].get('messages') or []:
    for b in m.get('content') or []:
        if isinstance(b, dict) and b.get('type') == 'image':
            found = True
            s = b.get('source') or {}
            print(f"  ✓ 转发 image: source.type={s.get('type')} "
                  f"media_type={s.get('media_type')} data_len={len(s.get('data') or '')}")
if not found:
    print('  ✗ 请求到了，但 content 里没有 image 块（被丢弃）')
open('probe-req.log', 'w').close()
PYEOF
done

echo
echo "== 结论（详见 docs/图片输入协议探针-2026-10-26.md）=="
echo "  base64 source  → 原样转发，data 长度不变"
echo "  url source     → 原样转发（远端会话可省流量）"
echo "  wrong media_type → CLI 按文件头嗅探后纠正（image/bmp → image/png）"
echo "  另：CLI 会把图落盘到 %TEMP%\\\\claude\\\\… 并在 content 末尾追加 [Image: source: <path>] 文本块"
