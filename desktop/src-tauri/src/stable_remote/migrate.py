"""Move one reviewed MCP entry; ordinary upgrades and daily verification stay separate."""
import copy
import re
import tempfile
import time

# 覆盖同名接入前的自动备份保留份数。备份是「覆盖」唯一的后悔药：.mcp.json 没有版本历史，
# 用户的 env / timeout / 自定义 header 一旦被我们整条换掉就找不回来了。
BACKUP_KEEP = 20


def backup_directory():
    # 和隧道端口账本（~/.cc-bridge/tunnel-port）放同一个目录，不额外发明位置。
    # 显式覆盖供测试隔离：fixture 不该在真实 home 里堆备份。
    override = os.environ.get('CCB_BACKUP_DIR')
    if override:
        return override
    return os.path.join(os.path.expanduser('~'), '.cc-bridge', 'backup')


def backup_file(filename, raw, label):
    """把将被覆盖的文件原字节留一份，返回备份路径。

    任何一步失败都直接向上抛（外层转成 CCB_CONFIG_FAILED），调用方据此放弃覆盖：
    备份的意义就是「覆盖之后还能找回手写的东西」，静默跳过的备份等于没有备份。
    """
    directory = backup_directory()
    os.makedirs(directory, mode=0o700, exist_ok=True)
    safe = ''.join(c if (c.isalnum() or c in '._-') else '_' for c in (label or 'config'))[:48] or 'config'
    kind = os.path.basename(filename).lstrip('.') or 'config'
    stamp = time.strftime('%Y%m%d-%H%M%S', time.localtime())
    for attempt in range(1, 100):
        suffix = '' if attempt == 1 else '-%d' % attempt
        path = os.path.join(directory, '%s-%s%s.%s' % (stamp, safe, suffix, kind))
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        with os.fdopen(fd, 'wb') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        prune_backups(directory, path)
        return path
    raise AccessError('CCB_CONFIG_FAILED')


def prune_backups(directory, latest):
    try:
        with os.scandir(directory) as entries:
            files = [(entry.stat(follow_symlinks=False).st_mtime_ns, entry.path) for entry in entries
                     if entry.path != latest and entry.is_file(follow_symlinks=False)
                     and re.fullmatch(r'\d{8}-\d{6}-.+\.(mcp|settings\.local)\.json', entry.name)]
        files.sort(reverse=True)
        for _, stale in files[BACKUP_KEEP - 1:]:
            os.unlink(stale)
    except OSError:
        # 备份已经落盘，清理旧份失败不该让这次覆盖失败。
        pass


def merge_entries(base, incoming):
    """以目标位置那条为基线，源条目只补齐目标没有的键。

    只替换 type / url / Authorization（由调用方统一做），其余字段全部留目标的：
    目标那条里的 env、timeout、alwaysAllow、disabled、自定义 header 可能是用户或同事
    特意写的，整条换成我们这份就等于静默删掉。源里独有、目标没有的键照样带过来。
    """
    merged = copy.deepcopy(base)
    for key, value in incoming.items():
        if key != 'headers':
            merged.setdefault(key, copy.deepcopy(value))
    if 'headers' in incoming:
        headers = merged.setdefault('headers', {})
        if not isinstance(headers, dict):
            raise AccessError('CCB_ENTRY_UNSUPPORTED')
        known_headers = {header.lower() for header in headers}
        for header, value in incoming['headers'].items():
            if header.lower() not in known_headers:
                headers[header] = copy.deepcopy(value)
                known_headers.add(header.lower())
    return merged


def migrate_access(p, access, base):
    selected = access.get('target')
    if not isinstance(selected, dict) or p['scope'] not in ('user', 'project'):
        raise AccessError('CCB_INSPECTION_REQUIRED')
    source_scope = selected['scope']
    source_project = absolute(selected['projectPath']) if source_scope != 'user' else ''
    destination_project = absolute(p['path']) if p['scope'] == 'project' else ''
    source_file = os.path.join(source_project, '.mcp.json') if source_scope == 'project' else global_file()
    destination_file = os.path.join(destination_project, '.mcp.json') if destination_project else global_file()
    project_key = selected.get('projectKey')
    if source_scope not in ('user', 'project', 'local') or selected['configFile'] != source_file or (
            source_scope == 'local' and (not project_key or absolute(project_key) != source_project)) or (
            ('user' if source_scope == 'user' else 'project') == p['scope'] and source_project == destination_project):
        raise AccessError('CCB_TARGET_CHANGED')
    for project in (source_project, destination_project):
        if project and not os.path.isdir(project):
            raise AccessError('CCB_PROJECT_MISSING')

    paths = sorted(set((global_file(), source_file, destination_file)))
    locks, temps, written, originals = [], set(), [], {}

    def stage(filename, raw, mode):
        fd, temp = tempfile.mkstemp(prefix='.cc-bridge-', dir=os.path.dirname(filename))
        temps.add(temp)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(temp, mode)
        return temp

    try:
        # Sorted, non-waiting locks bound the operation and avoid competing migrations.
        for filename in paths:
            if os.path.islink(filename):
                raise AccessError('CCB_CONFIG_SYMLINK')
            if not os.path.isdir(os.path.dirname(filename)):
                raise AccessError('CCB_CONFIG_DIRECTORY_MISSING')
            lock = filename + '.cc-bridge-lock'
            try:
                os.mkdir(lock, 0o700)
            except FileExistsError:
                raise AccessError('CCB_CONFIG_BUSY')
            locks.append(lock)
        for filename in paths:
            data, digest = snapshot(filename)
            path = os.path.dirname(filename) if filename != global_file() else ''
            expected = next((f for f in access['inspection']['files'] if f['configFile'] == filename and
                             f['scope'] == ('project' if path else 'user') and f['projectPath'] == path), None)
            if not expected or expected['fingerprint'] != digest:
                raise AccessError('CCB_TARGET_CHANGED')
            raw, mode = None, None
            if digest != 'missing':
                with open(filename, 'rb') as handle:
                    raw = handle.read(MAX_CONFIG + 1)
                if hashlib.sha256(raw).hexdigest() != digest:
                    raise AccessError('CCB_TARGET_CHANGED')
                mode = os.stat(filename).st_mode & 0o777
            originals[filename] = {'data': data, 'digest': digest, 'raw': raw, 'mode': mode}
        source_data = originals[source_file]['data']
        source_settings = project_map(source_data).get(project_key) if source_scope == 'local' else source_data
        if not isinstance(source_settings, dict):
            raise AccessError('CCB_TARGET_CHANGED')
        source_servers = mcp_map(source_settings)
        name = selected['name']
        entry = source_servers.get(name)
        if entry is None or entry_hash(entry) != selected['fingerprint'] or not endpoint(entry):
            raise AccessError('CCB_TARGET_CHANGED')
        if not isinstance(entry.get('headers', {}), dict):
            raise AccessError('CCB_ENTRY_UNSUPPORTED')
        destination_data = originals[destination_file]['data']
        # A legacy local entry takes priority over both global and .mcp.json entries:
        # 覆盖 .mcp.json 也压不住它，改了等于没改，所以这条路单独报出来让用户先处理旧条目。
        # 放在任何写操作（含备份）之前，被拒时不留副作用。
        effective_project = destination_project or source_project
        for key, settings in project_map(originals[global_file()]['data']).items():
            try:
                matching = absolute(key) == effective_project
            except AccessError:
                matching = False
            if matching and not (source_scope == 'local' and key == project_key) and name in mcp_map(settings):
                raise AccessError('CCB_SCOPE_LEGACY')
        destination_servers = mcp_map(destination_data)
        replaced = None
        if name in destination_servers:
            # 目标位置已有同名接入时能否覆盖，只看覆盖波及多大范围：
            # 项目级 `.mcp.json` 只影响这一个项目（各自目录本就隔离），可以合并覆盖；
            # 全局 `.claude.json` 一改就是这台服务器上所有项目，仍然拒绝。
            if not destination_project:
                raise AccessError('CCB_SCOPE_CONFLICT')
            existing = destination_servers[name]
            # 自定义名称可能被另一个 MCP 服务使用，仅凭名称或恰好相同的端口不足以确认归属。
            described = describe(p, name, existing, 'project', destination_file, destination_project)
            if not described or not (described['recognized'] or described['tokenMatches']):
                raise AccessError('CCB_SCOPE_PROJECT_CONFLICT')
            entry = merge_entries(existing, entry)
            if not isinstance(entry.get('headers', {}), dict):
                raise AccessError('CCB_ENTRY_UNSUPPORTED')
            raw = originals[destination_file]['raw']
            if raw is None:
                raise AccessError('CCB_TARGET_CHANGED')
            replaced = {
                'configFile': destination_file,
                'url': described['url'],
                'backup': backup_file(destination_file, raw, os.path.basename(destination_project)),
            }
        entry = copy.deepcopy(entry)
        entry['type'] = p['transport']
        entry['url'] = base + ('/mcp/sse' if p['transport'] == 'sse' else '/mcp')
        entry['headers'] = {k: v for k, v in entry.get('headers', {}).items() if k.lower() != 'authorization'}
        entry['headers']['Authorization'] = 'Bearer ' + p['token']
        destination_data.setdefault('mcpServers', {})[name] = entry
        del source_servers[name]
        configured = describe(p, name, entry, p['scope'], destination_file, destination_project)
        if not configured:
            raise AccessError('CCB_ENTRY_UNSUPPORTED')
        if replaced:
            # 事后可追溯：覆盖了谁、原来指向哪、备份在哪。不弹确认框，但要让用户查得到。
            configured['replaced'] = replaced

        # Establish the destination first; same-file legacy promotion is a single replacement.
        staged = []
        for filename in dict.fromkeys((destination_file, source_file)):
            raw = (json.dumps(originals[filename]['data'], ensure_ascii=False, indent=2) + '\n').encode('utf-8')
            if len(raw) > MAX_CONFIG:
                raise AccessError('CCB_CONFIG_TOO_LARGE')
            staged.append((filename, stage(filename, raw, originals[filename]['mode']), hashlib.sha256(raw).hexdigest()))
        for filename in paths:
            if snapshot(filename)[1] != originals[filename]['digest']:
                raise AccessError('CCB_TARGET_CHANGED')
        for filename, temp, digest in staged:
            if snapshot(filename)[1] != originals[filename]['digest']:
                raise AccessError('CCB_TARGET_CHANGED')
            os.replace(temp, filename)
            temps.remove(temp)
            written.append((filename, digest))
        return configured
    except Exception as failure:
        partial = False
        for filename, digest in reversed(written):
            try:
                # Roll back only our own bytes; never erase a concurrent external edit.
                if snapshot(filename)[1] != digest:
                    raise AccessError('CCB_TARGET_CHANGED')
                original = originals[filename]
                if original['raw'] is None:
                    os.unlink(filename)
                else:
                    temp = stage(filename, original['raw'], original['mode'])
                    if snapshot(filename)[1] != digest:
                        raise AccessError('CCB_TARGET_CHANGED')
                    os.replace(temp, filename)
                    temps.remove(temp)
            except Exception:
                partial = True
        if partial:
            raise AccessError('CCB_SCOPE_PARTIAL') from None
        if isinstance(failure, AccessError):
            raise
        raise AccessError('CCB_CONFIG_FAILED') from None
    finally:
        for temp in temps:
            try:
                os.unlink(temp)
            except OSError:
                pass
        for lock in reversed(locks):
            try:
                os.rmdir(lock)
            except OSError:
                pass
