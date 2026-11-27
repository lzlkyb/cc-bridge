"""Shared, bounded Claude configuration reads. Payloads arrive over stdin only."""
import base64
import hashlib
import hmac
import json
import os
import socket
import sys
import urllib.parse

MAX_CONFIG = 4 * 1024 * 1024
MAX_PROJECTS = 32
MAX_RESULT = 28 * 1024

# 共享服务器上的反向隧道端口段。sshd 的 `-R 127.0.0.1:<port>` 是独占绑定，
# 同一台机器上 N 个账号不可能共用一个端口，所以每人必须有自己的号。
#
# 段起点刻意避开历史候选 7823 / 17823 / 27823 / 37823：老版本就是拿这几个号轮着试，
# 若账本段从 17823 开始，uid 是 1000 倍数的账号（第一个普通用户往往就是）会正好
# 领到 17823，跟历史路径抢同一个号。
PORT_BASE = 17900
PORT_SPAN = 1000


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
    url = endpoint(entry)
    headers = entry.get('headers', {}) if isinstance(entry, dict) else {}
    authorization = ''
    if isinstance(headers, dict):
        authorization = next((v for k, v in headers.items() if k.lower() == 'authorization' and isinstance(v, str)), '')
    matches = hmac.compare_digest(authorization.encode(), ('Bearer ' + p['token']).encode())
    own = name == 'cc-bridge-' + str(p.get('deviceId') or '')
    if p.get('multi') and (name.startswith('cc-bridge-') and not own or name == 'cc-bridge' and not matches):
        return None
    # 🔴 多设备下不认别人的老条目。`cc-bridge` 是单设备时代的固定名：同账号两台都沿用
    # 它，写进去就是互相覆盖。所以开启多设备后，旧名只有令牌是本机时才算自己的（老用户
    # 原地升级）；令牌不符就当别人的接入忽略。未启用时判据逐字不变。
    known = own or name == 'cc-bridge'
    if known and not url:
        raise AccessError('CCB_ENTRY_UNSUPPORTED')
    if not url or len(name) > 256 or any(c in name for c in '\0\r\n'):
        return None
    if not isinstance(headers, dict):
        if known:
            raise AccessError('CCB_ENTRY_UNSUPPORTED')
        return None
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


def ledger_device(device_id):
    # 尾号会进文件名，只留 ASCII 字母数字与 -_，限长 32；空值退成固定串。
    key = ''.join(c for c in str(device_id or '') if c.isascii() and (c.isalnum() or c in '-_'))
    return key[:32] or 'device'


def tunnel_ledger(multi=False, device_id=''):
    override = os.environ.get('CCB_TUNNEL_PORT_FILE')
    base = override or os.path.join(os.path.expanduser('~'), '.cc-bridge', 'tunnel-port')
    return base + '-' + ledger_device(device_id) if multi else base


def read_port_file(path):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            port = int(handle.read(16).strip())
        return port if 1024 <= port <= 65535 else None
    except (OSError, ValueError):
        return None


def reserved_ports(device_id):
    directory, base = os.path.split(tunnel_ledger())
    own = base + '-' + ledger_device(device_id)
    reserved = set()
    try:
        with os.scandir(directory or '.') as entries:
            for entry in entries:
                suffix = entry.name[len(base) + 1:]
                if entry.name != base and (entry.name == own or not entry.name.startswith(base + '-') or
                                           not suffix or ledger_device(suffix) != suffix):
                    continue
                if entry.is_file(follow_symlinks=False):
                    reserved.add(read_port_file(entry.path))
    except OSError:
        pass
    return reserved


def write_tunnel_port(port, multi=False, device_id=''):
    path = tunnel_ledger(multi, device_id)
    temp = None
    try:
        # 覆盖成相对文件名（`CCB_TUNNEL_PORT_FILE=tunnel-port`）时 dirname 为空，
        # makedirs('') 会抛 FileNotFoundError，记账就静默失效了 —— 只建非空目录。
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, mode=0o700, exist_ok=True)
        temp = path + '.tmp'
        with open(temp, 'w', encoding='utf-8') as handle:
            handle.write(str(port) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    except OSError:
        # 记账失败不该让接入失败：端口仍然可用，只是下次要重新探一次。
        if temp:
            try:
                os.unlink(temp)
            except OSError:
                pass


def port_is_free(port):
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(('127.0.0.1', port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def tunnel_port(force=False, multi=False, device_id=''):
    # 正在使用的隧道会占住自己的端口。只在建隧道失败后强制换号。
    saved = read_port_file(tunnel_ledger(multi, device_id))
    if saved and not force:
        return saved
    # 服务器是 Linux；getattr 只为让本机（Windows）测试能跑同一段代码。
    uid = os.getuid() if hasattr(os, 'getuid') else 1000
    reserved = reserved_ports(device_id) if multi else ()
    if multi:
        # 同一账号的设备共享 uid。不同起点减少同时首次接入时的竞争。
        uid += int(hashlib.sha256(ledger_device(device_id).encode()).hexdigest()[:8], 16)
    offset_start = uid % PORT_SPAN
    if force and saved and PORT_BASE <= saved < PORT_BASE + PORT_SPAN:
        # 从刚被否掉的那个号之后继续，避免第一轮探测必然命中同一个不可用端口。
        offset_start = (saved - PORT_BASE + 1) % PORT_SPAN
    for offset in range(PORT_SPAN):
        port = PORT_BASE + ((offset_start + offset) % PORT_SPAN)
        if port != saved and port not in reserved and port_is_free(port):
            write_tunnel_port(port, multi, device_id)
            return port
    return 0


def inspect(p):
    result = {'signature': p['signature'], 'complete': True, 'home': os.path.expanduser('~'),
              'tunnelPort': tunnel_port(False, bool(p.get('multi')), p.get('deviceId') or ''),
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
