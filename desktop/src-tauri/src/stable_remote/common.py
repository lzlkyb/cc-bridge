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


def tunnel_ledger():
    # 默认放 ~/.cc-bridge/，与 cc_session 的 hosted/ 同目录但不同文件。
    # 显式覆盖供测试隔离，也给 HOME 只读的机器一条把账本挪到可写位置的出路。
    override = os.environ.get('CCB_TUNNEL_PORT_FILE')
    if override:
        return override
    return os.path.join(os.path.expanduser('~'), '.cc-bridge', 'tunnel-port')


def read_tunnel_port():
    try:
        with open(tunnel_ledger(), 'r', encoding='utf-8') as handle:
            port = int(handle.read(16).strip())
        return port if 1024 <= port <= 65535 else None
    except (OSError, ValueError):
        return None


def write_tunnel_port(port):
    path = tunnel_ledger()
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


def tunnel_port():
    """本账号在这台服务器上固定使用的反向隧道端口。

    🔴 为什么必须固定：共享服务器上 `-R 127.0.0.1:<port>` 是独占绑定，谁先绑谁用。
    如果端口是「接入那一刻碰巧空闲的那个」，那么 A 下班释放 7823、B 上线就会把它
    记成自己的，A 回来就永久撞车且无法自愈。账本按账号隔离（各自 home），
    所以别人离线期间也抢不走我的号。

    🔴 账本命中就直接返回，**即使此刻端口不可绑定**：正常使用中该端口正是被自己的
    sshd 反向监听占着（隧道活着，再次检查环境时就是这种状态）。若此时还去探测空闲，
    每次重新接入都会换号，已确认的 MCP 地址跟着漂移，等于把「固定端口」这件事废掉。
    真正的冲突由建隧道失败后的退避处置，见 candidate_ports。

    起点取 uid，是为了在没有账本时（首次 / 换了机器）也天然分散到不同端口，
    避免所有人从同一个起始号开始线性探测、把探测次数堆给排在后面的人。
    """
    saved = read_tunnel_port()
    if saved:
        return saved
    # 服务器是 Linux；getattr 只为让本机（Windows）测试能跑同一段代码。
    uid = os.getuid() if hasattr(os, 'getuid') else 1000
    start = PORT_BASE + (uid % PORT_SPAN)
    for offset in range(PORT_SPAN):
        port = PORT_BASE + ((start - PORT_BASE + offset) % PORT_SPAN)
        if port_is_free(port):
            write_tunnel_port(port)
            return port
    return 0


def inspect(p):
    result = {'signature': p['signature'], 'complete': True, 'home': os.path.expanduser('~'),
              'tunnelPort': tunnel_port(),
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
