"""Keep Claude Code's per-project MCP approval in step with the entry we just wrote."""


def enable_project_server(target):
    """把刚写好的项目级接入补进该项目的 enabledMcpjsonServers。

    Claude Code 的项目级 MCP 要「批准过」才会启用，名单落在
    `<项目>/.claude/settings.local.json` 的 enabledMcpjsonServers 里。只写 .mcp.json 不补名单，
    用户迁移完在 `/mcp` 看到的是未启用/待批准，会以为迁移失败（真机上确认过这一项是必需的）。

    只加不删：名单里其他接入原样保留；若 disabledMcpjsonServers 点名了它，那是用户明确关掉的，
    这里不翻案。项目里还没有 `.claude/`（Claude Code 没用过）时直接跳过，不替它建目录。
    任何失败都静默跳过 —— 迁移本身已经成功，辅助项写不进去不该把它报成失败。
    """
    if not isinstance(target, dict) or target.get('scope') != 'project':
        return
    project = target.get('projectPath')
    name = target.get('name')
    if not isinstance(project, str) or not project or not isinstance(name, str) or not name:
        return
    directory = os.path.join(project, '.claude')
    filename = os.path.join(directory, 'settings.local.json')
    temp = None
    try:
        # 软链一律不碰：写了也是在改别人指向的文件（`.claude` 本身是软链时同理）。
        if os.path.islink(filename) or os.path.islink(directory):
            return
        if not os.path.isdir(directory):
            # 这个项目还没跑过 Claude Code：不替它建 `.claude/`（会凭空在用户仓库里留目录），
            # 等它自己初始化，第一次用这个接入时按正常流程批准一次即可。
            return
        data, digest = snapshot(filename)
        enabled = data.get('enabledMcpjsonServers')
        if enabled is None:
            enabled = []
        elif not isinstance(enabled, list):
            return
        disabled = data.get('disabledMcpjsonServers')
        if name in enabled or (isinstance(disabled, list) and name in disabled):
            return
        data['enabledMcpjsonServers'] = enabled + [name]
        raw = (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        if len(raw) > MAX_CONFIG:
            return
        if digest != 'missing':
            with open(filename, 'rb') as handle:
                original = handle.read(MAX_CONFIG + 1)
            if hashlib.sha256(original).hexdigest() != digest:
                return
            backup_file(filename, original, os.path.basename(project))
            mode = os.stat(filename).st_mode & 0o777
        else:
            mode = 0o600
        fd, temp = tempfile.mkstemp(prefix='.cc-bridge-', dir=directory)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp, mode)
        if snapshot(filename)[1] != digest:
            raise AccessError('CCB_TARGET_CHANGED')
        os.replace(temp, filename)
        temp = None
    except Exception:
        # 失败即跳过，绝不影响已经落盘的接入配置。
        pass
    finally:
        if temp:
            try:
                os.unlink(temp)
            except OSError:
                pass
