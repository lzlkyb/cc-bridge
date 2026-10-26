"""假 Anthropic API：只为抓 claude CLI 发出的请求体。

批 C（图片输入协议探测）用。不依赖外网、不消耗额度：
把 `ANTHROPIC_BASE_URL` 指到本机，CLI 照常跑，我们把请求体原文落盘，
就能看到 stdin 里塞的 image block 到底有没有被转发给 API（而不是被丢弃或转成文字）。

用法：
    py -3 fake-anthropic.py 8899 requests.log      # 后台常驻
    ANTHROPIC_BASE_URL=http://127.0.0.1:8899 claude --print --input-format stream-json ...
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.log"

SSE = """event: message_start
data: {"type":"message_start","message":{"id":"msg_probe","type":"message","role":"assistant","model":"probe","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PROBE_OK"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}

event: message_stop
data: {"type":"message_stop"}

"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # 静音，避免刷屏
        pass

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            body = json.loads(raw)
        except Exception:
            body = {"__raw__": raw.decode("utf-8", errors="replace")[:4000]}

        # 把 path / 关键 header 一起记下：判定 CLI 走的是哪个端点
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(
                json.dumps(
                    {
                        "path": self.path,
                        "has_image_block": _has_image(body),
                        "ua": self.headers.get("user-agent", ""),
                        "body": body,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

        if "count_tokens" in self.path:
            payload = json.dumps({"input_tokens": 10}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        payload = SSE.encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.send_response(404)
        self.send_header("content-length", "0")
        self.end_headers()


def _has_image(body) -> bool:
    """递归找有没有 image 块 —— 单独留一个布尔值，方便一眼扫日志。"""
    if isinstance(body, dict):
        if body.get("type") == "image":
            return True
        return any(_has_image(v) for v in body.values())
    if isinstance(body, list):
        return any(_has_image(v) for v in body)
    return False


if __name__ == "__main__":
    print(f"listening on http://127.0.0.1:{PORT}, log -> {LOG}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
