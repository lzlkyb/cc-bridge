"""Scope migrations use disposable files and a fake bridge response, never saved servers."""
import base64
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
CONFIGURE = COMMON + '\n' + MIGRATE + '\n' + (ROOT / 'settings.py').read_text(encoding='utf-8') + '\n' + (ROOT / 'configure.py').read_text(encoding='utf-8')
ns = {}
exec(COMMON, ns)
# 端口账本指向临时文件：测试不该在真实 home 里留痕，也不该被宿主机端口占用影响。
# 走环境变量而不是替换 ns —— CONFIGURE 在全新 globals 里 exec，替换主进程 ns 对它无效。

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
    ledger = home / 'tunnel-port'
    os.environ['CCB_TUNNEL_PORT_FILE'] = str(ledger)
    # 备份目录也指到临时 home：覆盖同名接入会留备份，fixture 不该在真实 home 里堆文件。
    os.environ['CCB_BACKUP_DIR'] = str(home / 'backups')
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
        # 目的项目里也可能有同名条目，所以源必须按「范围 + 名字 + 项目路径」一起认。
        source = next(target for target in receipt['targets']
                      if target['scope'] == source_scope and target['name'] == name
                      and (source_scope == 'user' or target['projectPath'] == str(project)))
        return {'port': 43127, 'scope': destination, 'path': path, 'transport': 'http', 'name': name,
                'token': read_payload['token'], 'deviceId': 'device-a', 'ports': [43127],
                'access': {'target': source, 'inspection': receipt, 'scopeChange': True}}

    def bytes_before():
        return {file: file.read_bytes() if file.exists() else None for file in (global_file, project_file, other_file)}

    def assert_unchanged(before):
        assert bytes_before() == before

    def payload_of(output):
        """解出远端 CCB_DATA 帧，用来核对返回给客户端的字段（如覆盖记录）。"""
        chunks = [line[len('CCB_DATA '):] for line in output.splitlines() if line.startswith('CCB_DATA ')]
        return json.loads(base64.b64decode(''.join(chunks))) if chunks else None

    # A receipt created before enabling multi-device mode cannot move the other device's entry.
    _, project_data = reset()
    project_data['mcpServers']['cc-bridge-device-b'] = project_data['mcpServers'].pop(name)
    save(project_file, project_data)
    receipt = ns['inspect'](read_payload)
    foreign = next(t for t in receipt['targets'] if t['name'] == 'cc-bridge-device-b')
    payload = {'port': 43127, 'scope': 'user', 'path': '', 'transport': 'http', 'multi': True,
               'name': 'cc-bridge-device-a', 'deviceId': 'device-a', 'token': read_payload['token'],
               'ports': [43127], 'access': {'target': foreign, 'inspection': receipt, 'scopeChange': True}}
    before = bytes_before()
    code, output = execute(payload)
    assert code != 0 and 'CCB_TARGET_CHANGED' in output, output
    assert_unchanged(before)

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

    # 目标项目还没跑过 Claude Code（没有 `.claude/`）时不替它建目录，也不写启用名单。
    assert not (project / '.claude').exists(), '不该替用户创建 .claude 目录'

    # 目标位置的同名接入：项目级目标允许合并覆盖（留备份 + 保留目标里的手写字段），
    # 全局目标仍拒绝（一改影响这台服务器上所有项目）；legacy local 条目会压过 .mcp.json，
    # 覆盖了也不生效，所以单独报出来让用户先处理。
    keep = {'type': 'http', 'url': 'http://10.0.7.215:7823/mcp',
            'headers': {'Authorization': 'Bearer fixture-token', 'X-Custom': 'target', 'x-keep': 'target'},
            'env': {'KEEP_ENV': '1'}, 'timeout': 120, 'alwaysAllow': ['keep-tool']}

    # ① 项目 → 另一个项目，目标已有同名：覆盖，且目标的字段不能丢。
    reset()
    save(other_file, {'mcpServers': {name: copy.deepcopy(keep)}, 'customOther': ['keep']})
    other_before = other_file.read_text(encoding='utf-8')
    settings_file = other / '.claude' / 'settings.local.json'
    settings_file.parent.mkdir(exist_ok=True)
    save(settings_file, {'enabledMcpjsonServers': ['already-approved'], 'permissions': {'allow': ['keep']}})
    backup_dir = home / 'backups'
    backup_dir.mkdir(exist_ok=True)
    unrelated_backup = backup_dir / 'manual.json'
    unrelated_backup.write_text('{}', encoding='utf-8')
    for number in range(21):
        (backup_dir / ('20000101-000000-old-%02d.mcp.json' % number)).write_text('{}', encoding='utf-8')
    ledger.write_text('17942\n', encoding='utf-8')
    payload = request('project', 'project', str(other))
    code, output = execute(payload)
    assert code == 0 and 'CCB_CONFIGURED' in output, output
    other_after = json.loads(other_file.read_text(encoding='utf-8'))
    merged = other_after['mcpServers'][name]
    assert other_after['customOther'] == ['keep']
    assert merged['type'] == 'http' and merged['url'] == 'http://127.0.0.1:43127/mcp'
    assert merged['headers']['Authorization'] == 'Bearer fixture-token'
    assert merged['headers']['X-Custom'] == 'target' and merged['headers']['x-keep'] == 'target'
    assert 'X-Keep' not in merged['headers']
    assert merged['env'] == keep['env'] and merged['timeout'] == keep['timeout']
    assert merged['alwaysAllow'] == keep['alwaysAllow'] and merged['extraOption'] == entry['extraOption']
    assert name not in json.loads(project_file.read_text(encoding='utf-8'))['mcpServers']
    reported = payload_of(output)
    assert reported['replaced']['url'] == keep['url']
    assert reported['replaced']['configFile'] == str(other_file)
    # 备份必须是「原配置」的原字节，覆盖后才找得回来。
    assert Path(reported['replaced']['backup']).read_text(encoding='utf-8') == other_before
    assert ledger.read_text(encoding='utf-8') == '43127\n'
    assert unrelated_backup.read_text(encoding='utf-8') == '{}'
    assert len(list(backup_dir.glob('*.json'))) == 21
    # 迁移到项目后必须补进启用名单，否则 /mcp 里显示未启用；已有的名单项和 permissions 不能动。
    enabled = json.loads(settings_file.read_text(encoding='utf-8'))
    assert enabled['enabledMcpjsonServers'] == ['already-approved', name]
    assert enabled['permissions'] == {'allow': ['keep']}

    # ② 全局 → 项目，目标已有同名：同样覆盖（影响范围仍只限于这个项目）。
    reset('user')
    save(project_file, {'mcpServers': {name: copy.deepcopy(keep)}})
    project_settings = project / '.claude' / 'settings.local.json'
    project_settings.parent.mkdir()
    save(project_settings, {'disabledMcpjsonServers': [name]})
    disabled_before = project_settings.read_bytes()
    code, output = execute(request('user', 'project', str(project)))
    assert code == 0, output
    merged = json.loads(project_file.read_text(encoding='utf-8'))['mcpServers'][name]
    assert merged['url'] == 'http://127.0.0.1:43127/mcp' and merged['timeout'] == keep['timeout']
    assert name not in json.loads(global_file.read_text(encoding='utf-8'))['mcpServers']
    assert project_settings.read_bytes() == disabled_before

    # 自定义名称即使相同、端口也相同，仍可能属于别的服务。
    for existing in (None, {**keep, 'url': entry['url'], 'headers': {'Authorization': 'Bearer other-service'}}):
        reset('user')
        save(project_file, {'mcpServers': {name: existing}})
        payload = request('user', 'project', str(project))
        before = bytes_before()
        backups_before = list(backup_dir.iterdir())
        assert 'CCB_SCOPE_PROJECT_CONFLICT' in execute(payload)[1]
        assert_unchanged(before)
        assert list(backup_dir.iterdir()) == backups_before

    # ③ 项目 → 全局，全局已有同名：拒绝，原配置不动。
    reset('project')
    data = json.loads(global_file.read_text(encoding='utf-8'))
    data['mcpServers'][name] = copy.deepcopy(keep)
    save(global_file, data)
    payload = request('project', 'user')
    before = bytes_before()
    assert 'CCB_SCOPE_CONFLICT' in execute(payload)[1]
    assert_unchanged(before)

    # ④ legacy local 同名：拒绝，且不在备份目录留任何副作用。
    reset('user')
    data = json.loads(global_file.read_text(encoding='utf-8'))
    data['projects'][key]['mcpServers'] = {name: copy.deepcopy(keep)}
    save(global_file, data)
    backups_before = len(list((home / 'backups').glob('*.json')))
    payload = request('user', 'project', str(project))
    before = bytes_before()
    assert 'CCB_SCOPE_LEGACY' in execute(payload)[1]
    assert_unchanged(before)
    assert len(list((home / 'backups').glob('*.json'))) == backups_before

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
