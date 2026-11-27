"""Local fixtures only: never connects to saved SSH hosts or writes real Claude config."""
import contextlib
import http.server
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import threading

ROOT = Path(__file__).parent
COMMON = (ROOT / 'common.py').read_text(encoding='utf-8')
CONFIGURE = COMMON + '\n' + (ROOT / 'migrate.py').read_text(encoding='utf-8') + '\n' + (ROOT / 'settings.py').read_text(encoding='utf-8') + '\n' + (ROOT / 'configure.py').read_text(encoding='utf-8')
ns = {}
exec(COMMON, ns)
# 端口账本指向临时文件：测试不该在真实 home 里留痕，也不该被宿主机端口占用影响。
# 必须走环境变量而不是替换 ns —— CONFIGURE 用 exec(source, {}) 在全新 globals 里跑，
# 替换主进程 ns 对它无效（曾经因此把账本写进了真实 home）。
LEDGER = os.path.join(tempfile.gettempdir(), 'ccb-tunnel-port-%d' % os.getpid())
os.environ['CCB_TUNNEL_PORT_FILE'] = LEDGER
framed = __import__('base64').b64encode(json.dumps({'path': '项目目录/' * 600, 'token': 'fixture-secret'}, ensure_ascii=False).encode()).decode()
old_stdin = __import__('sys').stdin
__import__('sys').stdin = io.StringIO('\n'.join('CCB_PAYLOAD ' + framed[i:i+64] for i in range(0, len(framed), 64)) + '\nCCB_PAYLOAD_END\n')
with contextlib.redirect_stdout(io.StringIO()):
    assert ns['receive']()['path'] == '项目目录/' * 600
__import__('sys').stdin = old_stdin


class Handler(http.server.BaseHTTPRequestHandler):
    redirect = False
    leaked = False
    def do_POST(self):
        if self.path != '/mcp':
            Handler.leaked = True
        self.rfile.read(int(self.headers['Content-Length']))
        if Handler.redirect:
            self.send_response(307)
            self.send_header('Location', 'http://127.0.0.1:' + str(self.server.server_port) + '/stolen')
            self.end_headers()
            return
        self.send_response(200 if self.headers.get('Authorization') == 'Bearer fixture-current-token' else 401)
        self.end_headers()
        self.wfile.write(b'{"result":{"serverInfo":{"name":"cc-bridge"}}}')
    def do_GET(self):
        Handler.leaked = True
        self.send_response(200)
        self.end_headers()
    def log_message(self, *args):
        pass


def execute(source, payload):
    output = io.StringIO()
    old = __import__('sys').stdin
    __import__('sys').stdin = io.StringIO(json.dumps(payload) + '\n')
    try:
        with contextlib.redirect_stdout(output):
            try:
                exec(source, {})
            except SystemExit as error:
                return error.code, output.getvalue()
    finally:
        __import__('sys').stdin = old
    return 0, output.getvalue()


def save(filename, value):
    filename.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')


server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    os.environ['CLAUDE_CONFIG_DIR'] = str(home)
    # 覆盖同名接入/补 enabledMcpjsonServers 时会写备份，同样不能落到真实 home。
    os.environ['CCB_BACKUP_DIR'] = str(home / 'backups')
    os.environ['http_proxy'] = 'http://127.0.0.1:1'
    os.environ['no_proxy'] = ''
    project = home / '订单系统 with spaces'
    project.mkdir()
    other_project = home / 'other'
    other_project.mkdir()
    global_file = home / '.claude.json'
    project_file = project / '.mcp.json'
    p = {'signature': 'fixture-signature', 'deviceId': 'this-device', 'token': 'fixture-current-token',
         'ports': [7823, server.server_port], 'hints': [], 'path': None}
    bridge = {'type': 'http', 'url': 'http://192.168.31.81:7823/mcp?old=hidden-query',
              'headers': {'authorization': 'Bearer fixture-old-secret', 'X-Custom': 'keep-header'}, 'extraOption': True}
    unrelated = {'type': 'stdio', 'command': 'keep-command', 'env': {'SECRET': 'never-return-this'}}
    original = {'mcpServers': {'cc-bridge': bridge, 'other': unrelated},
                'projects': {str(project): {'allowedTools': ['keep']}}, 'custom': {'keep': True}}
    save(global_file, original)
    save(project_file, {'mcpServers': {'my-bridge': bridge, 'other': unrelated}})
    save(home / 'history.jsonl', {'project': str(other_project)})
    discovered = ns['inspect'](p)
    assert discovered['complete'] and len(discovered['targets']) == 2
    assert discovered['tunnelPort'] >= 1024, '检查结果必须带回该账号的隧道端口'
    assert {row['path'] for row in discovered['projects']} == {str(project), str(other_project)}
    target = next(t for t in discovered['targets'] if t['scope'] == 'user')
    custom = next(t for t in discovered['targets'] if t['scope'] == 'project')
    assert target['recognized'] and not target['tokenMatches'] and not custom['recognized']
    rendered = json.dumps(discovered)
    assert not any(secret in rendered for secret in ['fixture-old-secret', 'fixture-current-token', 'never-return-this', 'hidden-query', 'keep-header'])
    setup = {'port': server.server_port, 'scope': 'user', 'path': '', 'transport': 'http', 'name': 'cc-bridge',
             'token': p['token'], 'deviceId': p['deviceId'], 'ports': p['ports'],
             'access': {'target': target, 'inspection': discovered}}
    before = global_file.read_bytes()
    code, output = execute(CONFIGURE, {**setup, 'multi': True})
    assert code != 0 and 'CCB_TARGET_CHANGED' in output, output
    assert global_file.read_bytes() == before
    code, output = execute(CONFIGURE, setup)
    assert code == 0 and 'CCB_CONFIGURED' in output
    # 账本必须记下「实际写进 url 的端口」：隧道若因端口被占退避过，不写回就会每次
    # 接入先按旧账本失败一轮，甚至让已确认的地址在两次接入之间来回跳。
    assert open(LEDGER, encoding='utf-8').read().strip() == str(server.server_port)
    updated = json.loads(global_file.read_text(encoding='utf-8'))
    assert updated['custom'] == original['custom'] and updated['projects'] == original['projects']
    assert updated['mcpServers']['other'] == unrelated
    entry = updated['mcpServers']['cc-bridge']
    assert entry['extraOption'] and entry['headers'] == {'X-Custom': 'keep-header', 'Authorization': 'Bearer ' + p['token']}
    assert entry['url'] == 'http://127.0.0.1:' + str(server.server_port) + '/mcp'
    assert 'fixture-current-token' not in output
    before = global_file.read_bytes()
    assert execute(CONFIGURE, setup)[0] == 48 and global_file.read_bytes() == before
    assert 'CCB_TARGET_CHANGED' in execute(CONFIGURE, setup)[1]

    # A custom name is upgraded exactly where selected, with unrelated entries left intact.
    setup.update(scope='project', path=str(project), access={'target': custom, 'inspection': discovered})
    assert execute(CONFIGURE, setup)[0] == 0
    updated = json.loads(project_file.read_text(encoding='utf-8'))
    assert set(updated['mcpServers']) == {'my-bridge', 'other'} and updated['mcpServers']['other'] == unrelated
    assert updated['mcpServers']['my-bridge']['extraOption']

    # Legacy local scope uses the original project key, including its trailing separator.
    key = str(project) + os.sep
    local = {'mcpServers': {'other': unrelated}, 'projects': {key: {'mcpServers': {'old-custom': bridge}, 'allowedTools': ['keep']}}}
    save(global_file, local)
    save(project_file, {'mcpServers': {'other': unrelated}})
    scoped = ns['inspect']({**p, 'path': str(project)})
    legacy = next(t for t in scoped['targets'] if t['scope'] == 'local')
    setup['access'] = {'target': legacy, 'inspection': scoped}
    assert execute(CONFIGURE, setup)[0] == 0
    updated = json.loads(global_file.read_text(encoding='utf-8'))
    assert list(updated['projects']) == [key] and updated['projects'][key]['allowedTools'] == ['keep']
    assert updated['mcpServers'] == local['mcpServers']
    assert updated['projects'][key]['mcpServers']['old-custom']['url'].startswith('http://127.0.0.1:')
    assert json.loads(project_file.read_text(encoding='utf-8'))['mcpServers'] == {'other': unrelated}

    # New projects require a complete receipt; a changed or newly added target never gets overwritten.
    save(global_file, {'mcpServers': {'other': unrelated}})
    scoped = ns['inspect']({**p, 'path': str(project)})
    assert scoped['complete'] and not scoped['targets']
    setup['access'] = {'target': None, 'inspection': {**scoped, 'complete': False}}
    before = project_file.read_bytes()
    assert 'CCB_INSPECTION_REQUIRED' in execute(CONFIGURE, setup)[1] and project_file.read_bytes() == before
    setup['access']['inspection'] = scoped
    assert execute(CONFIGURE, setup)[0] == 0
    before = project_file.read_bytes()
    assert 'CCB_TARGET_CHANGED' in execute(CONFIGURE, setup)[1] and project_file.read_bytes() == before
    refreshed = ns['inspect']({**p, 'path': str(project)})
    setup['access']['inspection'] = refreshed
    assert 'CCB_TARGET_REQUIRED' in execute(CONFIGURE, setup)[1] and project_file.read_bytes() == before

    # Bad global/project files and same-name incompatible entries are failures, never "no existing entry".
    global_file.write_text('{bad', encoding='utf-8')
    failed = ns['inspect']({**p, 'path': str(project)})
    assert not failed['complete'] and 'CCB_CONFIG_READ_FAILED' in failed['warnings']
    setup['access'] = {'target': None, 'inspection': failed}
    assert 'CCB_INSPECTION_REQUIRED' in execute(CONFIGURE, setup)[1] and project_file.read_bytes() == before
    save(global_file, {'mcpServers': {'cc-bridge': unrelated}})
    assert not ns['inspect'](p)['complete']

    # Daily verification reads the saved target without writing files; unrelated broken config is ignored.
    save(project_file, {'mcpServers': {'cc-bridge': {**entry, 'headers': {'Authorization': 'Bearer ' + p['token']}}}})
    setup['verifyTarget'] = next(t for t in ns['inspect']({**p, 'path': str(project)})['targets'] if t['scope'] == 'project')
    setup['verifyOnly'] = True
    before = project_file.read_bytes()
    before_global = global_file.read_bytes()
    assert execute(CONFIGURE, setup)[0] == 0 and 'CCB_VERIFIED' in execute(CONFIGURE, setup)[1]
    assert global_file.read_bytes() == before_global and project_file.read_bytes() == before
    modified = json.loads(project_file.read_text(encoding='utf-8'))
    modified['mcpServers']['cc-bridge']['extraOption'] = 'external-edit'
    save(project_file, modified)
    changed_bytes = project_file.read_bytes()
    assert 'CCB_TARGET_CHANGED' in execute(CONFIGURE, setup)[1] and project_file.read_bytes() == changed_bytes
    project_file.write_bytes(before)
    setup['token'] = 'incorrect'
    assert execute(CONFIGURE, setup)[0] == 43 and project_file.read_bytes() == before
    setup['token'] = p['token']
    Handler.redirect = True
    assert execute(CONFIGURE, setup)[0] == 43 and not Handler.leaked
    Handler.redirect = False

    # Reading one selected project still works when another known project's config is malformed.
    save(global_file, {'projects': {str(project): {}, str(other_project): {}}})
    (other_project / '.mcp.json').write_text('{bad', encoding='utf-8')
    assert not ns['inspect'](p)['complete']
    assert ns['inspect']({**p, 'path': str(project)})['complete']

    # Folder results are bounded and expose folders only.
    folder_source = COMMON + '\n' + (ROOT / 'folders.py').read_text(encoding='utf-8')
    for index in range(260):
        (other_project / ('folder-' + str(index))).mkdir()
    code, output = execute(folder_source, {**p, 'path': str(other_project)})
    assert code == 0 and 'CCB_LISTED' in output and len(output.encode('utf-8')) < 48 * 1024
    decoded = __import__('base64').b64decode(''.join(line[9:] for line in output.splitlines() if line.startswith('CCB_DATA ')))
    listing = json.loads(decoded)
    assert listing['truncated'] and len(listing['directories']) <= 256
    assert all(row['name'].startswith('folder-') for row in listing['directories'])
    assert not list(project.glob('.cc-bridge-*')) and not (project / '.mcp.json.cc-bridge-lock').exists()
# 端口账本：共享服务器上 sshd 的反向监听是独占的，端口必须按账号固定下来。
# 账本命中就不再变，**哪怕此刻端口不可绑定**——正常使用中占着它的正是自己的 sshd，
# 一探测就换号会让已确认的 MCP 地址跟着漂。
ledger = ns['tunnel_ledger']()
if os.path.exists(ledger):
    os.unlink(ledger)
# 账本段不能压住历史候选 7823/17823/27823/37823：老版本拿这几个号轮着试，
# 段里若有同号，uid 落在该偏移上的账号会跟历史路径抢同一个端口。
legacy = {7823, 17823, 27823, 37823}
assert not legacy & set(range(ns['PORT_BASE'], ns['PORT_BASE'] + ns['PORT_SPAN']))
first = ns['tunnel_port']()
assert first >= 1024, first
assert open(ledger, encoding='utf-8').read().strip() == str(first)
assert ns['tunnel_port']() == first, '账本命中后必须稳定'
holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
holder.bind(('127.0.0.1', 0))
holder.listen(1)
taken = holder.getsockname()[1]
with open(ledger, 'w', encoding='utf-8') as handle:
    handle.write(str(taken) + '\n')
assert ns['port_is_free'](taken) is False
assert ns['tunnel_port']() == taken, '端口被占（自己的隧道）也不能换号'
holder.close()
# 失败后的自愈出口：账本里的号在服务器上被别人占了（换过机器、手工改过账本、历史遗留），
# 用户就会永远撞在同一个号上——本地候选 7823/17823 那批在同一台共享机上同样被占，
# 所以必须由账本所有者（服务器）跳过错号重分配，并把新号写回账本。
squatter = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
squatter.bind(('127.0.0.1', 0))
squatter.listen(1)
taken = squatter.getsockname()[1]
with open(ledger, 'w', encoding='utf-8') as handle:
    handle.write(str(taken) + '\n')
assert ns['tunnel_port']() == taken, 'force 之外绝不换号'
moved = ns['tunnel_port'](True)
assert moved != taken, (taken, moved)
assert ns['port_is_free'](moved) is True
assert open(ledger, encoding='utf-8').read().strip() == str(moved), '重分配必须写回账本'
squatter.close()
# 段内号被占时从它的下一个开始扫，而不是从 uid 起点重来：否则每轮都要先把
# 一串已知不可用的号重新探测一遍，冲突严重时白跑几百次 bind。
reserved = ns['PORT_BASE'] + 7
if ns['port_is_free'](reserved) and ns['port_is_free'](reserved + 1):
    squatter = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    squatter.bind(('127.0.0.1', reserved))
    squatter.listen(1)
    with open(ledger, 'w', encoding='utf-8') as handle:
        handle.write(str(reserved) + '\n')
    assert ns['tunnel_port'](True) == reserved + 1
    squatter.close()
# 账本损坏或越界时要能自愈，不能把脏值当成端口去监听。
for broken in ('garbage', '80', '99999', ''):
    with open(ledger, 'w', encoding='utf-8') as handle:
        handle.write(broken + '\n')
    healed = ns['tunnel_port']()
    assert 1024 <= healed <= 65535, (broken, healed)
    assert open(ledger, encoding='utf-8').read().strip() == str(healed)

# 多设备：同一个 SSH 账号的两台电脑共用 home，账本必须一人一本——共用一本就是
# 「后写者覆盖先写者」，正是 A 离线、B 记下 A 的号、A 回来永久撞车的成因。
with open(ledger + '-aaaa', 'w', encoding='utf-8') as handle:
    handle.write('%d\n' % (ns['PORT_BASE'] + 3))
with open(ledger + '-bbbb', 'w', encoding='utf-8') as handle:
    handle.write('%d\n' % (ns['PORT_BASE'] + 4))
legacy_before = open(ledger, encoding='utf-8').read().strip()
assert ns['tunnel_port'](False, True, 'aaaa') == ns['PORT_BASE'] + 3
assert ns['tunnel_port'](False, True, 'bbbb') == ns['PORT_BASE'] + 4, '两台设备必须各读各的账本'
assert ns['tunnel_port']() == int(legacy_before), '多设备读写不能碰旧账本'
# 设备尾号为空/脏值时按固定串归档，不能拼出目录外路径或覆盖别人的账本。
assert ns['ledger_device']('') == 'device'
assert ns['ledger_device']('../../etc/passwd') == 'etcpasswd', ns['ledger_device']('../../etc/passwd')
# 多设备首次接入不读旧账本：旧账本记的是「这个账号上次用的号」，很可能是另一台的。
fresh = ns['tunnel_port'](False, True, 'cccc')
assert ns['PORT_BASE'] <= fresh < ns['PORT_BASE'] + ns['PORT_SPAN'], fresh
assert open(ledger, encoding='utf-8').read().strip() == legacy_before, '首次分配也不能写旧账本'
assert open(ledger + '-cccc', encoding='utf-8').read().strip() == str(fresh)
with tempfile.TemporaryDirectory() as directory:
    isolated = Path(directory) / 'tunnel-port'
    os.environ['CCB_TUNNEL_PORT_FILE'] = str(isolated)
    # Both devices are offline between allocations, so only the ledger reserves the first port.
    free = ns['port_is_free']
    ns['port_is_free'] = lambda _port: True
    try:
        first = ns['tunnel_port'](False, True, 'new-device')
        original = isolated.with_name('tunnel-port-other-device')
        isolated.with_name('tunnel-port-new-device').rename(original)
        second = ns['tunnel_port'](False, True, 'new-device')
        assert first != second, '首次接入不能选已留给另一台离线设备的端口'
        assert int(original.read_text(encoding='utf-8')) == first
    finally:
        ns['port_is_free'] = free
        os.environ['CCB_TUNNEL_PORT_FILE'] = LEDGER

# 多设备下不抢别人的老条目：`cc-bridge` 是单设备时代的固定名，同账号两台都沿用它
# 就是继续互踢；令牌不是本机的旧条目必须当别人的接入忽略。
described = ns['describe']
own_headers = {'Authorization': 'Bearer tok'}
foreign = {'type': 'http', 'url': 'http://127.0.0.1:17900/mcp', 'headers': {'Authorization': 'Bearer other'}}
own = {'type': 'http', 'url': 'http://127.0.0.1:17900/mcp', 'headers': own_headers}
def access_payload(multi):
    return {'signature': 's', 'token': 'tok', 'deviceId': 'aaaa', 'ports': [7823], 'multi': multi}
assert described(access_payload(False), 'cc-bridge', foreign, 'user', '~/.claude.json')['recognized'] is True, \
    '未启用多设备时判据必须逐字不变'
assert described(access_payload(True), 'cc-bridge', foreign, 'user', '~/.claude.json') is None, \
    '多设备下令牌不匹配的旧条目应视为别人的接入'
assert described({**access_payload(True), 'ports': [17900]}, 'cc-bridge', foreign, 'user', '~/.claude.json') is None
assert described(access_payload(True), 'cc-bridge-bbbb', own, 'user', '~/.claude.json') is None
assert described(access_payload(True), 'cc-bridge', own, 'user', '~/.claude.json')['recognized'] is True, \
    '本机自己写的旧条目仍要认（老用户原地升级）'
assert described(access_payload(True), 'cc-bridge-aaaa', own, 'user', '~/.claude.json')['recognized'] is True
assert described(access_payload(False), 'cc-bridge-aaaa', foreign, 'user', '~/.claude.json') is not None, \
    '本机条目名不受令牌影响'

# 自愈脚本必须能被单独执行：Rust 侧只是把它的源码当字符串发过来，少一个符号
# （emit / receive / tunnel_port）直到真机才炸——而这条路径恰恰是用户已经失败过一次、
# 最没有耐心再来一轮的时候才会走到的。
REALLOCATE = COMMON + '\n' + (ROOT / 'reallocate.py').read_text(encoding='utf-8')
seeded = ns['PORT_BASE'] + 11
with open(ledger, 'w', encoding='utf-8') as handle:
    handle.write('%d\n' % seeded)
code, output = execute(REALLOCATE, {})
assert code == 0, (code, output)
assert 'CCB_PORT' in output, output
frames = ''.join(line[len('CCB_DATA '):] for line in output.splitlines() if line.startswith('CCB_DATA '))
moved = json.loads(__import__('base64').b64decode(frames))['port']
assert moved != seeded, (seeded, moved)
assert ns['PORT_BASE'] <= moved < ns['PORT_BASE'] + ns['PORT_SPAN'], moved

# 自愈脚本同样要跟着多设备走：payload 里有 multi/deviceId 时，换号结果只能写进
# 本机那本账，绝不能顺手把旧账本（很可能是另一台设备的号）改掉。
squatter = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
squatter.bind(('127.0.0.1', 0))
squatter.listen(1)
taken = squatter.getsockname()[1]
with open(ledger + '-dddd', 'w', encoding='utf-8') as handle:
    handle.write('%d\n' % taken)
legacy_before = open(ledger, encoding='utf-8').read().strip()
code, output = execute(REALLOCATE, {'multi': True, 'deviceId': 'dddd'})
assert code == 0, (code, output)
frames = ''.join(line[len('CCB_DATA '):] for line in output.splitlines() if line.startswith('CCB_DATA '))
multi_moved = json.loads(__import__('base64').b64decode(frames))['port']
assert multi_moved != taken, (taken, multi_moved)
assert open(ledger + '-dddd', encoding='utf-8').read().strip() == str(multi_moved)
assert open(ledger, encoding='utf-8').read().strip() == legacy_before, '多设备换号不能改旧账本'
squatter.close()

server.shutdown()
print('FIXTURE_OK')
