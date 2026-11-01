"""Real CLI + local fake Messages API. No paid model and no project file writes."""
import json
import os
import queue
import subprocess
import threading
import time
import uuid
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

out = Path(__file__).resolve().parents[2] / '.impeccable/review/steering'
out.mkdir(parents=True, exist_ok=True)
requests = []
mode = sys.argv[1] if len(sys.argv) > 1 else 'steer'

class API(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        if 'count_tokens' in self.path:
            self.send_response(200); self.end_headers(); self.wfile.write(b'{"input_tokens":20}'); return
        requests.append(data.get('messages', []))
        tool = len(requests) == 1 and mode != 'stream'
        blocks = [{'type': 'tool_use', 'id': 'tool-probe', 'name': 'Bash', 'input': {}}] if tool else [{'type': 'text', 'text': ''}]
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        def event(name, value):
            self.wfile.write(('event: ' + name + '\ndata: ' + json.dumps(value) + '\n\n').encode()); self.wfile.flush()
        try:
            event('message_start', {'type':'message_start','message':{'id':f'msg-{len(requests)}','type':'message','role':'assistant','model':'claude-sonnet-4-5','content':[],'stop_reason':None,'usage':{'input_tokens':20,'output_tokens':0}}})
            event('content_block_start', {'type':'content_block_start','index':0,'content_block':blocks[0]})
            delta = {'type':'input_json_delta','partial_json':json.dumps({'command':'sleep 3','description':'Harmless steering integration probe'})} if tool else {'type':'text_delta','text':'PROBE_COMPLETE'}
            event('content_block_delta', {'type':'content_block_delta','index':0,'delta':delta})
            if mode == 'stream' and len(requests) == 1: time.sleep(5)
            event('content_block_stop', {'type':'content_block_stop','index':0})
            event('message_delta', {'type':'message_delta','delta':{'stop_reason':'tool_use' if tool else 'end_turn','stop_sequence':None},'usage':{'output_tokens':8}})
            event('message_stop', {'type':'message_stop'})
        except (BrokenPipeError, ConnectionResetError): pass

server = ThreadingHTTPServer(('127.0.0.1', 0), API)
threading.Thread(target=server.serve_forever, daemon=True).start()
env = {k:v for k,v in os.environ.items() if k != 'CLAUDECODE'}
env.update({'ANTHROPIC_BASE_URL':f'http://127.0.0.1:{server.server_port}', 'ANTHROPIC_API_KEY':'local-probe-only', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1', 'DISABLE_NON_ESSENTIAL_MODEL_CALLS':'1', 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS':'1'})
cli = Path(os.environ['APPDATA']) / 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
args = [str(cli),'--print','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--replay-user-messages','--no-session-persistence','--setting-sources','','--settings','{"disableAllHooks":true}','--strict-mcp-config','--permission-prompt-tool','stdio','--model','claude-sonnet-4-5','--tools','Bash','--allowedTools','Bash','--max-turns','4']
process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
events = queue.Queue()
def read():
    for line in process.stdout:
        try: events.put(json.loads(line))
        except ValueError: pass
threading.Thread(target=read, daemon=True).start()
first, second = str(uuid.uuid4()), str(uuid.uuid4())
def send(value): process.stdin.write(json.dumps(value) + '\n'); process.stdin.flush()
def message(id, text): return {'type':'user','uuid':id,'message':{'role':'user','content':[{'type':'text','text':text}]}}
report = {'mode':mode,'first':first,'second':second,'events':[]}
control = str(uuid.uuid4())
try:
    send(message(first, 'Run the harmless tool provided by the test server, then summarize.'))
    sent = False
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        value = events.get(timeout=max(.1, deadline-time.monotonic()))
        kind = value.get('type'); report['events'].append({'type':kind,'subtype':value.get('subtype'),'uuid':value.get('uuid'),'isReplay':value.get('isReplay'),'user_message_uuid':value.get('user_message_uuid'),'user_message_uuids':value.get('user_message_uuids')})
        if kind == 'assistant' and any(block.get('type') == 'tool_use' for block in value.get('message',{}).get('content',[])) and not sent:
            sent = True
            if mode == 'steer': send(message(second, 'STEERING_MARKER: prioritize this correction in the current task.'))
            else:
                # Give the harmless tool time to start; the subprocess is exclusively this probe's.
                time.sleep(.4)
                request = {'subtype':'background_tasks','tool_use_id':'tool-probe'} if mode in ['background','now'] else {'subtype':'interrupt'}
                send({'type':'control_request','request_id':control,'request':request})
        if mode == 'stream' and kind == 'stream_event' and value.get('event',{}).get('type') == 'content_block_delta' and not sent:
            sent = True
            send({'type':'control_request','request_id':control,'request':{'subtype':'interrupt'}})
        if kind == 'control_response' and value.get('response',{}).get('request_id') == control:
            report['controlResponse'] = value['response']
            if mode == 'now' and value['response'].get('response',{}).get('backgrounded') is False:
                mode = 'now-interrupt'; control = str(uuid.uuid4())
                send({'type':'control_request','request_id':control,'request':{'subtype':'interrupt'}})
                continue
            send(message(second, 'STEERING_MARKER: prioritize this correction now.'))
        if kind == 'control_request':
            send({'type':'control_response','response':{'subtype':'success','request_id':value['request_id'],'response':{'behavior':'allow','updatedInput':value['request'].get('input',{})}}})
        if kind == 'result' and second in value.get('user_message_uuids', [value.get('user_message_uuid')]): break
    report['requestCount'] = len(requests)
    report['secondRequestContainsSteering'] = len(requests) >= 2 and 'STEERING_MARKER' in json.dumps(requests[1])
except Exception as error: report['error'] = str(error) or type(error).__name__
finally:
    process.stdin.close()
    try: process.wait(timeout=5)
    except subprocess.TimeoutExpired: process.kill(); process.wait()
    server.shutdown(); server.server_close()
    (out/f'cli-probe-{mode}.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({key:value for key,value in report.items() if key != 'events'},indent=2))

# A report file alone must not make a failed integration probe look green to automation.
answered = any(event['type'] == 'result' and second in (event.get('user_message_uuids') or [event.get('user_message_uuid')]) for event in report['events'])
if report.get('error') or not report.get('secondRequestContainsSteering') or not answered:
    raise SystemExit(1)
