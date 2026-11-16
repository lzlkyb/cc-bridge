try:
    emit('CCB_DISCOVERED', inspect(receive()))
except AccessError as error:
    stop(error.marker)
except Exception:
    stop('CCB_CONFIG_READ_FAILED')
