# 建隧道失败后的自愈出口：账本里的号在这台服务器上被别人占了，就换一个。
#
# 只做一件事：强制重分配并回一个端口号。真正的隧道重建、配置重写由 Rust 侧接着做，
# 所以这里不碰 Claude 配置、不探测 MCP 端点，也不做任何写入（除了账本本身）。
p = receive()  # 必须读掉入站帧：Rust 侧在等到 CCB_INPUT_READY 之后才发 payload。
emit('CCB_PORT', {'port': tunnel_port(True, bool(p.get('multi')), p.get('deviceId') or '')})
