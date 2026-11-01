"""No-model protocol probe: initialize an isolated CLI, then stop a nonexistent ID."""
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

cli = Path(os.environ['APPDATA']) / 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
out = Path(__file__).resolve().parents[2] / '.impeccable/review/task-stop'
out.mkdir(parents=True, exist_ok=True)
process = subprocess.Popen([str(cli), '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--permission-prompt-tool', 'stdio'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
events = queue.Queue()
seen_types = []
diagnostics = []
def read_errors():
    for line in process.stderr:
        for key, value in os.environ.items():
            if value and re.search('KEY|TOKEN|SECRET|PASSWORD', key, re.I):
                line = line.replace(value, '[redacted]')
        diagnostics.append(line[:1000])
threading.Thread(target=read_errors, daemon=True).start()
def read():
    for line in process.stdout:
        try:
            value = json.loads(line)
            seen_types.append(value.get('type'))
            if value.get('type') == 'control_response':
                events.put(value)
        except ValueError:
            pass
threading.Thread(target=read, daemon=True).start()
report = []
try:
    requests = [('probe-init', {'subtype': 'initialize', 'hooks': {}}), ('probe-stop', {'subtype': 'stop_task', 'task_id': 'ccbridge-probe-nonexistent-task'})]
    if '--skip-initialize' in sys.argv:
        requests = requests[1:]
    for request_id, request in requests:
        process.stdin.write(json.dumps({'type': 'control_request', 'request_id': request_id, 'request': request}) + '\n')
        process.stdin.flush()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            response = events.get(timeout=max(.1, deadline - time.monotonic()))['response']
            if response.get('request_id') == request_id:
                report.append({'request': request['subtype'], 'subtype': response.get('subtype'), 'error': response.get('error'), 'response': response.get('response') if request_id == 'probe-stop' else None})
                break
        else:
            raise TimeoutError(request_id)
except Exception as error:
    report.append({'probeError': str(error) or type(error).__name__, 'exitCode': process.poll(), 'seenTypes': seen_types, 'diagnostics': diagnostics[-3:]})
finally:
    process.stdin.close()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    filename = 'protocol-probe-direct.json' if '--skip-initialize' in sys.argv else 'protocol-probe.json'
    (out / filename).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))

if any('probeError' in entry for entry in report):
    raise SystemExit(1)
