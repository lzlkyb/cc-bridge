"""Local fixtures only: never connects to saved SSH hosts or writes real Claude config."""
import contextlib
import http.server
import io
import json
import os
from pathlib import Path
import tempfile
import threading

ROOT = Path(__file__).parent
COMMON = (ROOT / 'common.py').read_text(encoding='utf-8')
CONFIGURE = COMMON + '\n' + (ROOT / 'migrate.py').read_text(encoding='utf-8') + '\n' + (ROOT / 'configure.py').read_text(encoding='utf-8')
ns = {}
exec(COMMON, ns)
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
    assert {row['path'] for row in discovered['projects']} == {str(project), str(other_project)}
    target = next(t for t in discovered['targets'] if t['scope'] == 'user')
    custom = next(t for t in discovered['targets'] if t['scope'] == 'project')
    assert target['recognized'] and not target['tokenMatches'] and not custom['recognized']
    rendered = json.dumps(discovered)
    assert not any(secret in rendered for secret in ['fixture-old-secret', 'fixture-current-token', 'never-return-this', 'hidden-query', 'keep-header'])
    setup = {'port': server.server_port, 'scope': 'user', 'path': '', 'transport': 'http', 'name': 'cc-bridge',
             'token': p['token'], 'deviceId': p['deviceId'], 'ports': p['ports'],
             'access': {'target': target, 'inspection': discovered}}
    code, output = execute(CONFIGURE, setup)
    assert code == 0 and 'CCB_CONFIGURED' in output
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
server.shutdown()
print('FIXTURE_OK')
