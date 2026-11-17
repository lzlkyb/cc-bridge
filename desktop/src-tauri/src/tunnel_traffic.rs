//! Private, per-attempt loopback relay for measuring managed SSH forwarding.
use std::io;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time;

const SAMPLE_INTERVAL: Duration = Duration::from_millis(200);
const COPY_BUFFER_SIZE: usize = 32 * 1024;

#[derive(Default)]
struct Counters {
    to_local: AtomicU64,
    to_remote: AtomicU64,
    activity: Notify,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ByteDelta {
    pub to_local: u64,
    pub to_remote: u64,
}

/// Dropping an SSH attempt also retires its listener and every in-flight socket.
pub(crate) struct Relay {
    pub port: u16,
    task: JoinHandle<()>,
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Relay {
    pub async fn start(
        target: (String, u16),
        on_activity: impl Fn(ByteDelta) + Send + 'static,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let task = tokio::spawn(serve(listener, target, on_activity));
        Ok(Self { port, task })
    }
}

async fn serve(listener: TcpListener, target: (String, u16), on_activity: impl Fn(ByteDelta)) {
    let counters = Arc::new(Counters::default());
    tokio::select! {
        _ = forward_connections(listener, target, &counters) => {},
        _ = report_activity(&counters, on_activity) => {},
    }
}

async fn forward_connections(
    listener: TcpListener,
    target: (String, u16),
    counters: &Arc<Counters>,
) {
    let mut streams = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    let target = target.clone();
                    let counters = counters.clone();
                    streams.spawn(async move {
                        let _ = forward(socket, target, &counters).await;
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::ConnectionAborted => continue,
                Err(error) => {
                    log::debug!("隧道流量入口暂时无法接受连接：{error}");
                    time::sleep(SAMPLE_INTERVAL).await;
                }
            },
            _ = streams.join_next(), if !streams.is_empty() => {},
        }
    }
}

async fn report_activity(counters: &Counters, on_activity: impl Fn(ByteDelta)) {
    loop {
        counters.activity.notified().await;
        if counters.to_local.load(Relaxed) == 0 && counters.to_remote.load(Relaxed) == 0 {
            continue;
        }
        // Coalesce both directions after the first write. Idle relays have no running timer.
        time::sleep(SAMPLE_INTERVAL).await;
        on_activity(ByteDelta {
            to_local: counters.to_local.swap(0, Relaxed),
            to_remote: counters.to_remote.swap(0, Relaxed),
        });
    }
}

async fn forward(
    mut source: TcpStream,
    target: (String, u16),
    counters: &Counters,
) -> io::Result<()> {
    let mut local = TcpStream::connect((target.0.as_str(), target.1)).await?;
    source.set_nodelay(true)?;
    local.set_nodelay(true)?;
    let (from_remote, to_remote) = source.split();
    let (from_local, to_local) = local.split();
    tokio::try_join!(
        copy_counted(
            from_remote,
            to_local,
            &counters.to_local,
            &counters.activity
        ),
        copy_counted(
            from_local,
            to_remote,
            &counters.to_remote,
            &counters.activity
        ),
    )?;
    Ok(())
}

async fn copy_counted(
    mut reader: impl AsyncRead + Unpin,
    mut writer: impl AsyncWrite + Unpin,
    bytes: &AtomicU64,
    activity: &Notify,
) -> io::Result<()> {
    let mut buffer = [0u8; COPY_BUFFER_SIZE];
    loop {
        let len = reader.read(&mut buffer).await?;
        if len == 0 {
            // The response can still arrive after the requester closes its write half.
            return writer.shutdown().await;
        }
        writer.write_all(&buffer[..len]).await?;
        if bytes.fetch_add(len as u64, Relaxed) == 0 {
            activity.notify_one();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn reports_each_direction_before_the_connection_closes_and_isolates_relays() {
        time::timeout(Duration::from_secs(5), async {
            let service = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let target = ("127.0.0.1".into(), service.local_addr().unwrap().port());
            let (a_tx, mut a_rx) = mpsc::unbounded_channel();
            let (b_tx, mut b_rx) = mpsc::unbounded_channel();
            let a = Relay::start(target, move |delta| a_tx.send(delta).unwrap())
                .await
                .unwrap();
            let b = Relay::start(
                ("127.0.0.1".into(), service.local_addr().unwrap().port()),
                move |delta| b_tx.send(delta).unwrap(),
            )
            .await
            .unwrap();
            let mut remote = TcpStream::connect(("127.0.0.1", a.port)).await.unwrap();
            let (mut local, _) = service.accept().await.unwrap();

            remote.write_all(b"mcp").await.unwrap();
            let mut request = [0; 3];
            local.read_exact(&mut request).await.unwrap();
            assert_eq!(&request, b"mcp");
            assert_eq!(
                a_rx.recv().await.unwrap(),
                ByteDelta {
                    to_local: 3,
                    to_remote: 0
                }
            );

            remote.shutdown().await.unwrap();
            assert_eq!(local.read(&mut request).await.unwrap(), 0);
            local.write_all(b"ok").await.unwrap();
            let mut response = [0; 2];
            remote.read_exact(&mut response).await.unwrap();
            assert_eq!(&response, b"ok");
            assert_eq!(
                a_rx.recv().await.unwrap(),
                ByteDelta {
                    to_local: 0,
                    to_remote: 2
                }
            );

            // A direct connection emits nothing, and a second relay has its own counters.
            let mut direct = TcpStream::connect(service.local_addr().unwrap())
                .await
                .unwrap();
            let (mut direct_peer, _) = service.accept().await.unwrap();
            direct.write_all(b"mcp").await.unwrap();
            direct_peer.read_exact(&mut request).await.unwrap();
            let mut other = TcpStream::connect(("127.0.0.1", b.port)).await.unwrap();
            let (mut other_local, _) = service.accept().await.unwrap();
            other.write_all(b"x").await.unwrap();
            other_local.read_exact(&mut request[..1]).await.unwrap();
            assert_eq!(
                b_rx.recv().await.unwrap(),
                ByteDelta {
                    to_local: 1,
                    to_remote: 0
                }
            );
            assert!(time::timeout(SAMPLE_INTERVAL * 2, a_rx.recv())
                .await
                .is_err());
            assert!(b_rx.try_recv().is_err());

            drop(a);
            assert_eq!(remote.read(&mut response).await.unwrap(), 0);
            other_local.write_all(b"x").await.unwrap();
            other.read_exact(&mut response[..1]).await.unwrap();
        })
        .await
        .unwrap();
    }
}
