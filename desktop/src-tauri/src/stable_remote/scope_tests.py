"""Scope migrations use disposable files and a fake bridge response, never saved servers."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
# The remote inspect.py is a concatenated script, not Python's standard inspect module.
sys.path = [entry for entry in sys.path if Path(entry).resolve() != ROOT]
from unittest.mock import patch

COMMON = (ROOT / 'common.py').read_text(encoding='utf-8')
MIGRATE = (ROOT / 'migrate.py').read_text(encoding='utf-8') if (ROOT / 'migrate.py').exists() else ''
CONFIGURE = COMMON + '\n' + MIGRATE + '\n' + (ROOT / 'configure.py').read_text(encoding='utf-8')
ns = {}
exec(COMMON, ns)
# 端口账本指向临时文件：测试不该在真实 home 里留痕，也不该被宿主机端口占用影响。
# 走环境变量而不是替换 ns —— CONFIGURE 在全新 globals 里 exec，替换主进程 ns 对它无效。
os.environ['CCB_TUNNEL_PORT_FILE'] = os.path.join(
    tempfile.gettempdir(), 'ccb-scope-tunnel-port-%d' % os.getpid())


class Response:
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def read(self, limit):
        return b'{"result":{"serverInfo":{"name":"cc-bridge"}}}'


def execute(payload, replace=None):
    output = io.StringIO()
    old = sys.stdin
    sys.stdin = io.StringIO(json.dumps(payload) + '\n')
    try:
        with contextlib.redirect_stdout(output), patch('urllib.request.OpenerDirector.open', return_value=Response()):
            with patch('os.replace', side_effect=replace or os.replace):
                try:
                    exec(CONFIGURE, {})
                except SystemExit as error:
                    return error.code, output.getvalue()
    finally:
        sys.stdin = old
    return 0, output.getvalue()


with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    os.environ['CLAUDE_CONFIG_DIR'] = str(home)
    project = home / '订单项目 with spaces'
    other = home / '另一个项目'
    project.mkdir()
    other.mkdir()
    global_file = home / '.claude.json'
    project_file = project / '.mcp.json'
    other_file = other / '.mcp.json'
    key = str(project) + os.sep
    name = 'custom-bridge'
    entry = {'type': 'http', 'url': 'http://127.0.0.1:43127/mcp',
             'headers': {'authorization': 'Bearer old-token', 'X-Keep': 'keep'}, 'extraOption': {'keep': True}}
    unrelated = {'command': 'keep-other-tool', 'env': {'SECRET': 'never-return'}}
    read_payload = {'signature': 'fixture-signature', 'deviceId': 'device-a', 'token': 'fixture-token',
                    'ports': [43127], 'hints': [], 'path': str(project)}

    def save(file, data):
        file.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')

    def reset(scope='project', destination_exists=True):
        global_data = {'mcpServers': {'other': unrelated}, 'projects': {key: {'allowedTools': ['keep']}}, 'custom': {'keep': True}}
        project_data = {'mcpServers': {'other': unrelated}, 'customProject': ['keep']}
        if scope == 'user':
            global_data['mcpServers'][name] = copy.deepcopy(entry)
        elif scope == 'local':
            global_data['projects'][key]['mcpServers'] = {name: copy.deepcopy(entry), 'other-local': unrelated}
        else:
            project_data['mcpServers'][name] = copy.deepcopy(entry)
        save(global_file, global_data)
        save(project_file, project_data)
        save(other_file, {'mcpServers': {'other': unrelated}})
        if not destination_exists:
            other_file.unlink()
        return global_data, project_data

    def request(source_scope, destination, path=''):
        receipt = ns['inspect']({**read_payload, 'path': path or None, 'sourceProjectPath': str(project) if source_scope != 'user' else ''})
        assert receipt['complete'], receipt['warnings']
        source = next(target for target in receipt['targets'] if target['scope'] == source_scope and target['name'] == name)
        return {'port': 43127, 'scope': destination, 'path': path, 'transport': 'http', 'name': name,
                'token': read_payload['token'], 'deviceId': 'device-a', 'ports': [43127],
                'access': {'target': source, 'inspection': receipt, 'scopeChange': True}}

    def bytes_before():
        return {file: file.read_bytes() if file.exists() else None for file in (global_file, project_file, other_file)}

    def assert_unchanged(before):
        assert bytes_before() == before

    # Project -> global preserves the name/options and removes exactly the old project entry.
    global_original, project_original = reset()
    payload = request('project', 'user')
    code, output = execute(payload)
    assert code == 0 and 'CCB_CONFIGURED' in output, output
    global_after = json.loads(global_file.read_text(encoding='utf-8'))
    project_after = json.loads(project_file.read_text(encoding='utf-8'))
    assert global_after['projects'] == global_original['projects'] and global_after['custom'] == global_original['custom']
    assert project_after == {**project_original, 'mcpServers': {'other': unrelated}}
    moved = global_after['mcpServers'][name]
    assert moved['url'] == entry['url'] and moved['extraOption'] == entry['extraOption']
    assert moved['headers'] == {'X-Keep': 'keep', 'Authorization': 'Bearer fixture-token'}
    assert global_after['mcpServers']['other'] == unrelated
    assert not any(secret in output for secret in ('fixture-token', 'old-token', 'never-return', 'X-Keep'))

    # Global -> project, project -> other project, and exact-key legacy promotion.
    for source_scope, destination, destination_path in [('user', 'project', str(project)), ('project', 'project', str(other)), ('local', 'user', '')]:
        reset(source_scope)
        payload = request(source_scope, destination, destination_path)
        code, output = execute(payload)
        assert code == 0, output
        destination_file = global_file if destination == 'user' else Path(destination_path) / '.mcp.json'
        assert json.loads(destination_file.read_text(encoding='utf-8'))['mcpServers'][name]['url'] == entry['url']
        source_file = project_file if source_scope == 'project' else global_file
        source_data = json.loads(source_file.read_text(encoding='utf-8'))
        source_settings = source_data['projects'][key] if source_scope == 'local' else source_data
        assert name not in source_settings['mcpServers']
        if source_scope == 'local':
            assert list(source_data['projects']) == [key] and source_settings['allowedTools'] == ['keep']
            assert source_settings['mcpServers']['other-local'] == unrelated

    # A migration must be explicit, with current source and destination receipts.
    for invalid in ('ordinary', 'stale-source', 'stale-destination', 'missing-proof', 'no-target'):
        reset()
        payload = request('project', 'user')
        if invalid == 'ordinary':
            payload['access']['scopeChange'] = False
        elif invalid == 'stale-source':
            data = json.loads(project_file.read_text(encoding='utf-8'))
            data['mcpServers'][name]['extraOption'] = 'changed'
            save(project_file, data)
        elif invalid == 'stale-destination':
            save(global_file, {'custom': 'changed'})
        elif invalid == 'missing-proof':
            payload['access']['inspection']['files'] = [proof for proof in payload['access']['inspection']['files'] if proof['scope'] == 'project']
        else:
            payload['access']['target'] = None
        before = bytes_before()
        assert execute(payload)[0] != 0, invalid
        assert_unchanged(before)

    # Destination same-name entries and local-scope overrides are never overwritten.
    for collision in ('global', 'project', 'local'):
        source_scope = 'project' if collision == 'global' else 'user'
        reset(source_scope)
        if collision == 'global':
            data = json.loads(global_file.read_text(encoding='utf-8'))
            data['mcpServers'][name] = {**entry, 'extraOption': 'other-global'}
            save(global_file, data)
        elif collision == 'project':
            save(project_file, {'mcpServers': {name: {**entry, 'extraOption': 'other-project'}}})
        else:
            data = json.loads(global_file.read_text(encoding='utf-8'))
            data['projects'][key]['mcpServers'] = {name: {**entry, 'extraOption': 'other-local'}}
            save(global_file, data)
        payload = request(source_scope, 'user' if collision == 'global' else 'project', '' if collision == 'global' else str(project))
        before = bytes_before()
        assert 'CCB_SCOPE_CONFLICT' in execute(payload)[1], collision
        assert_unchanged(before)

    # Lock contention releases only our locks and never waits on an active writer.
    reset()
    payload = request('project', 'user')
    lock = Path(str(project_file) + '.cc-bridge-lock')
    lock.mkdir()
    before = bytes_before()
    assert 'CCB_CONFIG_BUSY' in execute(payload)[1]
    assert_unchanged(before)
    assert lock.is_dir() and not Path(str(global_file) + '.cc-bridge-lock').exists()
    lock.rmdir()

    # A failure removing the source restores exact original bytes (or a missing destination).
    real_replace = os.replace
    for destination_exists in (True, False):
        reset(destination_exists=destination_exists)
        payload = request('project', 'project', str(other))
        before = bytes_before()
        writes = [0]
        def fail_source(source, destination):
            writes[0] += 1
            if writes[0] == 2:
                raise OSError('fixture source-write failure')
            return real_replace(source, destination)
        code, output = execute(payload, fail_source)
        assert code != 0 and 'CCB_CONFIG_FAILED' in output, output
        assert_unchanged(before)

    # External edits after a partial write are preserved and reported as incomplete migration.
    reset()
    payload = request('project', 'user')
    source_before = project_file.read_bytes()
    writes = [0]
    def external_edit(source, destination):
        writes[0] += 1
        if writes[0] == 2:
            data = json.loads(global_file.read_text(encoding='utf-8'))
            data['externalChange'] = 'keep-new-edit'
            save(global_file, data)
            raise OSError('fixture external edit')
        return real_replace(source, destination)
    code, output = execute(payload, external_edit)
    assert code != 0 and 'CCB_SCOPE_PARTIAL' in output, output
    assert project_file.read_bytes() == source_before
    assert json.loads(global_file.read_text(encoding='utf-8'))['externalChange'] == 'keep-new-edit'

    # Explicit source/destination checks ignore unrelated broken recent-project configs.
    reset()
    other_file.write_text('{bad', encoding='utf-8')
    save(home / 'history.jsonl', {'project': str(other)})
    payload = request('project', 'user')
    assert {proof['configFile'] for proof in payload['access']['inspection']['files']} == {str(global_file), str(project_file)}
    ready = json.loads(project_file.read_text(encoding='utf-8'))
    ready['mcpServers'][name]['headers']['authorization'] = 'Bearer fixture-token'
    save(project_file, ready)
    payload['verifyTarget'] = next(target for target in ns['inspect']({**read_payload, 'sourceProjectPath': str(project)})['targets'] if target['scope'] == 'project' and target['name'] == name)
    before = bytes_before()
    payload['verifyOnly'] = True
    assert 'CCB_VERIFIED' in execute(payload)[1]
    assert_unchanged(before)
    assert not any(home.rglob('.cc-bridge-*')) and not any(home.rglob('*.cc-bridge-lock'))
print('SCOPE_FIXTURE_OK')
