import json
import os
import sys
import tempfile

scope, name, old_urls, url, transport, token = json.loads(sys.argv[1])
if isinstance(old_urls, str):
    old_urls = [old_urls]
filename = '.mcp.json' if scope == 'project' else os.path.join(os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR', '~')), '.claude.json')
if os.path.islink(filename):
    raise SystemExit('配置文件是链接，请手动检查原接入。')
with open(filename, 'rb') as handle:
    original = handle.read()
data = json.loads(original.decode('utf-8-sig'))
entry = data.get('mcpServers', {}).get(name)
if not isinstance(entry, dict) or entry.get('url') not in [*old_urls, url]:
    raise SystemExit('原接入不存在或地址已被修改，请检查后重试。')
headers = entry.get('headers', {})
if not isinstance(headers, dict):
    raise SystemExit('原接入的请求头格式无效，请手动检查。')
entry['url'] = url
entry['type'] = transport
entry['headers'] = {k: v for k, v in headers.items() if k.lower() != 'authorization'}
entry['headers']['Authorization'] = 'Bearer ' + token
parent = os.path.dirname(os.path.abspath(filename))
fd, temporary = tempfile.mkstemp(prefix='.cc-bridge-', dir=parent)
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    if os.path.islink(filename):
        raise SystemExit('配置文件变成了链接，请重新检查原接入。')
    with open(filename, 'rb') as handle:
        if handle.read() != original:
            raise SystemExit('接入配置在更新期间发生变化，请重新检查。')
    os.chmod(temporary, os.stat(filename).st_mode & 0o777)
    os.replace(temporary, filename)
    print('原接入已更新，请重新打开 Claude Code。')
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
