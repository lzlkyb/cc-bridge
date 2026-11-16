try:
    p = receive()
    path = absolute(p.get('path') or '~')
    if not os.path.isdir(path):
        raise AccessError('CCB_PROJECT_MISSING')
    directories = []
    truncated = False
    with os.scandir(path) as rows:
        for index, row in enumerate(rows):
            if index >= 4096 or len(directories) >= 256:
                truncated = True
                break
            if not row.name.startswith('.') and row.is_dir():
                directories.append({'name': row.name, 'path': os.path.join(path, row.name)})
    directories.sort(key=lambda row: row['name'].casefold())
    result = {'signature': p['signature'], 'home': os.path.expanduser('~'), 'path': path,
              'parent': os.path.dirname(path), 'directories': directories, 'truncated': truncated}
    while len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) > MAX_RESULT and directories:
        directories.pop()
        result['truncated'] = True
    emit('CCB_LISTED', result)
except AccessError as error:
    stop(error.marker)
except OSError:
    stop('CCB_FOLDER_READ_FAILED')
except Exception:
    stop('CCB_CONFIG_READ_FAILED')
