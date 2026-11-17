"""Existing IP/Token update tests use disposable configuration files only."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
sys.path = [entry for entry in sys.path if Path(entry).resolve() != ROOT]
from unittest.mock import patch

SOURCE = (ROOT.parent / 'direct_access_update.py').read_text(encoding='utf-8')


def execute(payload, before_commit=None):
    real_fsync = os.fsync

    def fsync(fd):
        real_fsync(fd)
        if before_commit:
            before_commit()

    with patch.object(sys, 'argv', ['update', json.dumps(payload)]), patch('os.fsync', side_effect=fsync), contextlib.redirect_stdout(io.StringIO()):
        try:
            exec(SOURCE, {})
        except SystemExit:
            return False
    return True


original_cwd = Path.cwd()
with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    os.environ['CLAUDE_CONFIG_DIR'] = str(home)
    project = home / '订单系统 with spaces'
    project.mkdir()
    os.chdir(project)
    original = {'mcpServers': {
        'my-bridge': {'type': 'http', 'url': 'http://10.0.0.2:7823/mcp',
                      'headers': {'authorization': 'Bearer old', 'X-Custom': 'keep'}, 'extraOption': {'value': 2}},
        'other': {'url': 'http://10.0.0.2:7823/mcp', 'headers': {'Authorization': 'keep-other-token'}}},
        'custom': [True, '保留']}
    payload = ['project', 'my-bridge', 'http://10.0.0.2:7823/mcp', 'https://10.9.0.8:9123/mcp/sse', 'sse', 'new-token']
    project_file = project / '.mcp.json'
    global_file = home / '.claude.json'
    raw = ('\ufeff' + json.dumps(original, ensure_ascii=False, indent=2)).replace('\n', '\r\n').encode('utf-8')
    for scope, filename in [('project', project_file), ('user', global_file)]:
        filename.write_bytes(raw)
        global_file.write_bytes(raw)
        global_before = global_file.read_bytes()
        payload[0] = scope
        assert execute(payload)
        data = json.loads(filename.read_text(encoding='utf-8'))
        expected = copy.deepcopy(original)
        expected['mcpServers']['my-bridge'].update(type='sse', url=payload[3], headers={'X-Custom': 'keep', 'Authorization': 'Bearer new-token'})
        assert data == expected
        if scope == 'project':
            assert global_file.read_bytes() == global_before
        # Repeat Token changes accept the latest URL, while preserving all unrelated values.
        payload[5] = 'next-token'
        assert execute(payload)
        # 必须显式指定 utf-8：CI runner 是英文 locale（cp1252），默认编码读不了
        # 中文路径下这份含「保留」的文件，字节 0x9d 会直接抛 UnicodeDecodeError。
        assert json.loads(filename.read_text(encoding='utf-8'))['mcpServers']['my-bridge']['headers']['Authorization'] == 'Bearer next-token'
        payload[5] = 'new-token'

    payload[0] = 'project'
    project_file.write_bytes(raw)
    assert execute(payload)
    next_url = 'http://10.9.0.9:9123/mcp'
    successive = ['project', 'my-bridge', [payload[2], payload[3]], next_url, 'http', 'third-token']
    assert execute(successive)
    assert json.loads(project_file.read_text(encoding='utf-8'))['mcpServers']['my-bridge']['url'] == next_url

    for malformed in ['missing-entry', 'changed-url', 'bad-headers']:
        data = copy.deepcopy(original)
        if malformed == 'missing-entry':
            del data['mcpServers']['my-bridge']
        elif malformed == 'changed-url':
            data['mcpServers']['my-bridge']['url'] = 'http://elsewhere:7823/mcp'
        else:
            data['mcpServers']['my-bridge']['headers'] = 'invalid'
        before = json.dumps(data).encode()
        project_file.write_bytes(before)
        assert not execute(payload) and project_file.read_bytes() == before
        assert not list(project.glob('.cc-bridge-*'))

    # A CRLF-to-LF edit has the same decoded text under universal newline reads;
    # comparing original bytes must still refuse to replace that concurrent edit.
    project_file.write_bytes(raw)
    changed = raw.replace(b'\r\n', b'\n')
    assert not execute(payload, lambda: project_file.write_bytes(changed))
    assert project_file.read_bytes() == changed and not list(project.glob('.cc-bridge-*'))
    os.chdir(original_cwd)
print('DIRECT_UPDATE_OK')
