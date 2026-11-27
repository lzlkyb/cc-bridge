import copy
import tempfile
import urllib.request
import urllib.error

p = receive()
base = 'http://127.0.0.1:' + str(p['port'])
probe = {'jsonrpc': '2.0', 'id': 'ccbridge-setup', 'method': 'initialize', 'params': {
    'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'cc-bridge-setup', 'version': '1'}}}
req = urllib.request.Request(base + '/mcp', json.dumps(probe).encode(), {
    'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p['token']})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, 'redirect refused', headers, fp)


try:
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(req, timeout=10) as response:
        result = json.loads(response.read(65536))
    if result.get('result', {}).get('serverInfo', {}).get('name') != 'cc-bridge':
        raise ValueError('unexpected server')
except Exception:
    stop('CCB_VERIFY_FAILED', 43)

# Daily checks and VPN recovery never rewrite or re-add an MCP entry.
if p.get('verifyOnly'):
    selected = p.get('verifyTarget')
    if not isinstance(selected, dict):
        stop('CCB_INSPECTION_REQUIRED')
    try:
        project = absolute(selected['projectPath']) if selected['scope'] != 'user' else ''
        filename = os.path.join(project, '.mcp.json') if selected['scope'] == 'project' else global_file()
        if selected['configFile'] != filename:
            raise AccessError('CCB_TARGET_CHANGED')
        data, _ = snapshot(filename)
        settings = project_map(data).get(selected.get('projectKey')) if selected['scope'] == 'local' else data
        if not isinstance(settings, dict):
            raise AccessError('CCB_TARGET_CHANGED')
        entry = mcp_map(settings).get(selected['name'])
        verified = describe(p, selected['name'], entry, selected['scope'], filename, project, selected.get('projectKey'))
        if not verified or verified['fingerprint'] != selected['fingerprint'] or not verified['tokenMatches'] or verified['url'] != base + '/mcp':
            raise AccessError('CCB_TARGET_CHANGED')
        emit('CCB_VERIFIED', verified)
    except AccessError as error:
        stop(error.marker)
    raise SystemExit(0)

access = p.get('access')
if not isinstance(access, dict) or not access.get('inspection', {}).get('complete'):
    stop('CCB_INSPECTION_REQUIRED')
if access.get('scopeChange'):
    try:
        configured = migrate_access(p, access, base)
        write_tunnel_port(p['port'], bool(p.get('multi')), p.get('deviceId') or '')
        enable_project_server(configured)
        emit('CCB_CONFIGURED', configured)
    except AccessError as error:
        stop(error.marker)
    raise SystemExit(0)
selected = access.get('target')
scope = selected['scope'] if selected else p['scope']
project = absolute(p['path']) if p['scope'] == 'project' else ''
if project and not os.path.isdir(project):
    stop('CCB_PROJECT_MISSING', 44)
filename = os.path.join(project, '.mcp.json') if scope == 'project' else global_file()
name = selected['name'] if selected else p['name']
project_key = selected.get('projectKey') if selected else None
if selected and (selected['configFile'] != filename or selected['projectPath'] != project or
                 (scope == 'local' and (not project_key or absolute(project_key) != project))):
    stop('CCB_TARGET_CHANGED')
if os.path.islink(filename):
    stop('CCB_CONFIG_SYMLINK', 46)
parent = os.path.dirname(filename)
if not os.path.isdir(parent):
    stop('CCB_CONFIG_DIRECTORY_MISSING', 45)
lock = filename + '.cc-bridge-lock'
try:
    os.mkdir(lock, 0o700)
except FileExistsError:
    stop('CCB_CONFIG_BUSY', 47)
except OSError:
    stop('CCB_CONFIG_FAILED')
temp = None
try:
    data, before = snapshot(filename)
    if scope == 'local':
        settings = project_map(data).get(project_key)
        if not isinstance(settings, dict):
            raise AccessError('CCB_TARGET_CHANGED')
    else:
        settings = data
    servers = mcp_map(settings)
    if selected:
        entry = servers.get(name)
        if entry is None or entry_hash(entry) != selected['fingerprint'] or not endpoint(entry) or (
                p.get('multi') and not describe(p, name, entry, scope, filename, project, project_key)):
            raise AccessError('CCB_TARGET_CHANGED')
        entry = copy.deepcopy(entry)
        if not isinstance(entry.get('headers', {}), dict):
            raise AccessError('CCB_ENTRY_UNSUPPORTED')
    else:
        expected = next((f for f in access['inspection']['files'] if f['configFile'] == filename and f['scope'] == scope and f['projectPath'] == project), None)
        if not expected or expected['fingerprint'] != before:
            raise AccessError('CCB_TARGET_CHANGED')
        if name in servers or any(describe(p, key, value, scope, filename, project) for key, value in servers.items()):
            raise AccessError('CCB_TARGET_REQUIRED')
        if project:
            global_data, global_digest = snapshot(global_file())
            global_proof = next((f for f in access['inspection']['files'] if f['scope'] == 'user' and f['configFile'] == global_file()), None)
            if not global_proof or global_proof['fingerprint'] != global_digest:
                raise AccessError('CCB_TARGET_CHANGED')
            for key, value in project_map(global_data).items():
                if absolute(key) == project and any(describe(p, n, e, 'local', global_file(), project, key) for n, e in mcp_map(value).items()):
                    raise AccessError('CCB_TARGET_REQUIRED')
        entry = {}
    # Keep the original name, scope, extra options, and non-Authorization headers.
    entry['type'] = p['transport']
    entry['url'] = base + ('/mcp/sse' if p['transport'] == 'sse' else '/mcp')
    entry['headers'] = {k: v for k, v in entry.get('headers', {}).items() if k.lower() != 'authorization'}
    entry['headers']['Authorization'] = 'Bearer ' + p['token']
    settings.setdefault('mcpServers', {})[name] = entry
    fd, temp = tempfile.mkstemp(prefix='.cc-bridge-', dir=parent)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    if snapshot(filename)[1] != before:
        raise AccessError('CCB_TARGET_CHANGED')
    if os.path.exists(filename):
        os.chmod(temp, os.stat(filename).st_mode & 0o777)
    os.replace(temp, filename)
    temp = None
    configured = describe(p, name, entry, scope, filename, project, project_key)
    enable_project_server(configured)
    # 账本必须反映「实际写进配置的端口」。隧道可能因为账本里的号被别人占了而退避到
    # 别的端口，若不写回，下次检查又会拿回那个被占的号，地址在两次接入之间来回跳。
    write_tunnel_port(p['port'], bool(p.get('multi')), p.get('deviceId') or '')
    emit('CCB_CONFIGURED', configured)
except AccessError as error:
    stop(error.marker, 44 if error.marker == 'CCB_PROJECT_MISSING' else 48)
except Exception:
    stop('CCB_CONFIG_FAILED', 48)
finally:
    if temp:
        try:
            os.unlink(temp)
        except OSError:
            pass
    try:
        os.rmdir(lock)
    except OSError:
        pass
