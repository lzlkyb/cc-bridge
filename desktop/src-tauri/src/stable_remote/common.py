"""Shared, bounded Claude configuration reads. Payloads arrive over stdin only."""
import base64
import hashlib
import hmac
import json
import os
import sys
import urllib.parse

MAX_CONFIG = 4 * 1024 * 1024
MAX_PROJECTS = 32
MAX_RESULT = 28 * 1024


class AccessError(Exception):
    def __init__(self, marker):
        self.marker = marker


def stop(marker, code=48):
    print(marker, flush=True)
    raise SystemExit(code)


def receive():
    # SSH's password prompt need not end in a newline.
    print('\nCCB_INPUT_READY', flush=True)
    first = sys.stdin.readline()
    if not first.startswith('CCB_PAYLOAD '):
        return json.loads(first)
    encoded = first[len('CCB_PAYLOAD '):].strip()
    for _ in range(700):
        line = sys.stdin.readline().strip()
        if line == 'CCB_PAYLOAD_END':
            raw = base64.b64decode(encoded, validate=True)
            if len(raw) > 32 * 1024:
                raise AccessError('CCB_RESULT_OVERFLOW')
            return json.loads(raw)
        if not line.startswith('CCB_PAYLOAD ') or len(encoded) > 44 * 1024:
            raise AccessError('CCB_CONFIG_READ_FAILED')
        encoded += line[len('CCB_PAYLOAD '):]
    raise AccessError('CCB_RESULT_OVERFLOW')


def emit(marker, value):
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(raw) > MAX_RESULT:
        stop('CCB_RESULT_OVERFLOW')
    encoded = base64.b64encode(raw).decode('ascii')
    # Short frames survive both remote terminal wrapping and Windows ConPTY.
    for offset in range(0, len(encoded), 64):
        print('CCB_DATA ' + encoded[offset:offset + 64])
    print(marker, flush=True)


def absolute(path):
    if not isinstance(path, str) or len(path) > 4096 or any(c in path for c in '\0\r\n'):
        raise AccessError('CCB_PROJECT_MISSING')
    if not os.path.isabs(path) and not path.startswith('~'):
        raise AccessError('CCB_PROJECT_MISSING')
    return os.path.abspath(os.path.expanduser(path))


def global_file():
    directory = os.environ.get('CLAUDE_CONFIG_DIR')
    return os.path.abspath(os.path.join(os.path.expanduser(directory), '.claude.json')) if directory else os.path.expanduser('~/.claude.json')


def snapshot(filename):
    if os.path.islink(filename):
        raise AccessError('CCB_CONFIG_SYMLINK')
    if not os.path.isdir(os.path.dirname(filename)):
        raise AccessError('CCB_CONFIG_DIRECTORY_MISSING')
    try:
        with open(filename, 'rb') as handle:
            raw = handle.read(MAX_CONFIG + 1)
    except FileNotFoundError:
        return {}, 'missing'
    except OSError:
        raise AccessError('CCB_CONFIG_READ_FAILED')
    if len(raw) > MAX_CONFIG:
        raise AccessError('CCB_CONFIG_TOO_LARGE')
    try:
        data = json.loads(raw.decode('utf-8-sig'))
        if not isinstance(data, dict):
            raise ValueError('object required')
    except (ValueError, UnicodeError):
        raise AccessError('CCB_CONFIG_READ_FAILED')
    return data, hashlib.sha256(raw).hexdigest()


def entry_hash(entry):
    return hashlib.sha256(json.dumps(entry, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def mcp_map(data):
    value = data.get('mcpServers', {})
    if not isinstance(value, dict):
        raise AccessError('CCB_CONFIG_READ_FAILED')
    return value


def project_map(data):
    value = data.get('projects', {})
    if not isinstance(value, dict):
        raise AccessError('CCB_CONFIG_READ_FAILED')
    return value


def endpoint(entry):
    if not isinstance(entry, dict) or entry.get('type', 'http') not in ('http', 'sse'):
        return None
    url = entry.get('url')
    if not isinstance(url, str) or len(url) > 4096:
        return None
    try:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.path.rstrip('/') not in ('/mcp', '/mcp/sse'):
            return None
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        # Never return a query string: older configurations can contain credentials there.
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, '', '')), port
    except ValueError:
        return None


def describe(p, name, entry, scope, filename, path='', project_key=None):
    known = name in ('cc-bridge', 'cc-bridge-' + p['deviceId'])
    url = endpoint(entry)
    if known and not url:
        raise AccessError('CCB_ENTRY_UNSUPPORTED')
    if not url or len(name) > 256 or any(c in name for c in '\0\r\n'):
        return None
    headers = entry.get('headers', {})
    if not isinstance(headers, dict):
        if known:
            raise AccessError('CCB_ENTRY_UNSUPPORTED')
        return None
    authorization = next((v for k, v in headers.items() if k.lower() == 'authorization' and isinstance(v, str)), '')
    matches = hmac.compare_digest(authorization.encode(), ('Bearer ' + p['token']).encode())
    if not known and not matches and url[1] not in p['ports']:
        return None
    identity = [scope, filename, project_key, name]
    return {
        'id': entry_hash(identity), 'name': name, 'scope': scope,
        'projectPath': path, 'projectKey': project_key, 'configFile': filename,
        'url': url[0], 'fingerprint': entry_hash(entry),
        'recognized': known, 'tokenMatches': matches,
    }


def proof(scope, path, filename, fingerprint):
    return {'scope': scope, 'projectPath': path, 'configFile': filename, 'fingerprint': fingerprint}


def known_projects(data, p):
    paths = []
    limited = False
    def add(path):
        nonlocal limited
        try:
            path = absolute(path)
        except AccessError:
            return
        if path in paths:
            return
        if len(paths) < MAX_PROJECTS:
            paths.append(path)
        else:
            limited = True
    for path in p.get('hints', []):
        if path:
            add(path)
    config_directory = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
    history = os.path.join(os.path.expanduser(config_directory), 'history.jsonl')
    try:
        with open(history, 'rb') as handle:
            handle.seek(0, os.SEEK_END)
            start = max(0, handle.tell() - 256 * 1024)
            handle.seek(start)
            lines = handle.read(256 * 1024).splitlines()
        if start:
            lines = lines[1:]
        for line in reversed(lines[-512:]):
            try:
                item = json.loads(line)
                if isinstance(item, dict):
                    add(item.get('project'))
            except (ValueError, UnicodeError):
                pass
    except OSError:
        # History is an optional convenience; the actual config is always checked.
        pass
    for path in project_map(data):
        add(path)
    return paths, limited


def inspect(p):
    result = {'signature': p['signature'], 'complete': True, 'home': os.path.expanduser('~'),
              'inspectedProjectPath': None, 'projects': [], 'targets': [], 'files': [], 'warnings': []}
    def warning(marker):
        result['complete'] = False
        if marker not in result['warnings']:
            result['warnings'].append(marker)
    def entries(data, scope, filename, path='', project_key=None):
        for name, entry in mcp_map(data).items():
            target = describe(p, name, entry, scope, filename, path, project_key)
            if target:
                if len(result['targets']) >= 64:
                    raise AccessError('CCB_RESULT_OVERFLOW')
                result['targets'].append(target)
    filename = global_file()
    try:
        data, digest = snapshot(filename)
        result['files'].append(proof('user', '', filename, digest))
        entries(data, 'user', filename)
        paths, limited = known_projects(data, p)
        if limited and not p.get('path') and p.get('sourceProjectPath') is None:
            warning('CCB_PROJECTS_LIMITED')
    except AccessError as error:
        warning(error.marker)
        data, paths = {}, []
    for path in paths:
        if os.path.isdir(path):
            result['projects'].append({'name': os.path.basename(path) or path, 'path': path})
    if p.get('path') or p.get('sourceProjectPath') is not None:
        try:
            paths = [absolute(p['path'])] if p.get('path') else []
            result['inspectedProjectPath'] = paths[0] if paths else None
            if p.get('sourceProjectPath'):
                source = absolute(p['sourceProjectPath'])
                if source not in paths:
                    paths.append(source)
            for path in paths:
                if not os.path.isdir(path):
                    raise AccessError('CCB_PROJECT_MISSING')
        except AccessError as error:
            warning(error.marker)
            paths = []
    for path in paths:
        try:
            # Legacy local-scope entries retain the exact JSON key, even when it contains a trailing slash.
            for key, settings in project_map(data).items():
                try:
                    matching = absolute(key) == path
                except AccessError:
                    matching = False
                if matching:
                    if not isinstance(settings, dict):
                        raise AccessError('CCB_CONFIG_READ_FAILED')
                    entries(settings, 'local', filename, path, key)
            if not os.path.isdir(path):
                continue
            project_file = os.path.join(path, '.mcp.json')
            settings, digest = snapshot(project_file)
            result['files'].append(proof('project', path, project_file, digest))
            entries(settings, 'project', project_file, path)
        except AccessError as error:
            warning(error.marker)
    while len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) > MAX_RESULT:
        warning('CCB_RESULT_OVERFLOW')
        if result['projects']:
            result['projects'].pop()
        elif result['targets']:
            result['targets'].pop()
        elif len(result['files']) > 1:
            result['files'].pop()
        else:
            stop('CCB_RESULT_OVERFLOW')
    return result
