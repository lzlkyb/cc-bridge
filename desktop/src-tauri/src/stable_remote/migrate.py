"""Move one reviewed MCP entry; ordinary upgrades and daily verification stay separate."""
import copy
import tempfile


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
        if name in mcp_map(destination_data):
            raise AccessError('CCB_SCOPE_CONFLICT')
        # A legacy local entry takes priority over both global and .mcp.json entries.
        effective_project = destination_project or source_project
        for key, settings in project_map(originals[global_file()]['data']).items():
            try:
                matching = absolute(key) == effective_project
            except AccessError:
                matching = False
            if matching and not (source_scope == 'local' and key == project_key) and name in mcp_map(settings):
                raise AccessError('CCB_SCOPE_CONFLICT')
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
