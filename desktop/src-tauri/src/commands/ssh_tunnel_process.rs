//! PTY execution shared by the managed listener and its bounded ownership check.
use super::ssh_tunnel_cmds::{read_loop, Fatal, Killer};
use crate::ssh_proxy::PendingCreds;
use crate::ssh_tunnel_guard::{
    GuardAttempt, GuardError, GuardFrame, GuardReceipt, ManagedGuard, ReclaimReply, ReclaimResult,
    GUARD_START_TIMEOUT, HEARTBEAT_INTERVAL, PROTOCOL_PREFIX,
};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub(super) enum Output<'a> {
    SshLine(&'a str),
    GuardReady,
}

enum GuardMode {
    Serve {
        guard: Arc<ManagedGuard>,
        attempt: GuardAttempt,
    },
    Reclaim {
        nonce: String,
    },
}

#[derive(Default)]
struct GuardProgress {
    ready: bool,
    last_heartbeat: Option<Instant>,
    reply: Option<ReclaimResult>,
    failure: Option<Fatal>,
    debug_command: bool,
}

pub(super) struct GuardRun {
    mode: GuardMode,
    stop: Arc<AtomicBool>,
    progress: Mutex<GuardProgress>,
    #[cfg(test)]
    heartbeat_count: std::sync::atomic::AtomicUsize,
}

impl GuardRun {
    pub fn serve(guard: Arc<ManagedGuard>, attempt: GuardAttempt, stop: Arc<AtomicBool>) -> Self {
        Self::new(GuardMode::Serve { guard, attempt }, stop)
    }

    pub fn reclaim(nonce: String, stop: Arc<AtomicBool>) -> Self {
        Self::new(GuardMode::Reclaim { nonce }, stop)
    }

    fn new(mode: GuardMode, stop: Arc<AtomicBool>) -> Self {
        Self {
            mode,
            stop,
            progress: Mutex::new(GuardProgress::default()),
            #[cfg(test)]
            heartbeat_count: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn consume<'a>(&self, line: &'a str) -> Option<Output<'a>> {
        if !line.trim().starts_with(PROTOCOL_PREFIX) {
            return self.ssh_output(line);
        }
        if self.stop.load(Ordering::SeqCst) {
            return None;
        }
        let Some(frame) = GuardFrame::parse(line) else {
            // Heartbeat echo and other protocol input are never an SSH failure message.
            return None;
        };
        let frame = match frame {
            Ok(frame) => frame,
            Err(message) => {
                self.fail(Fatal::Other(message));
                return None;
            }
        };
        match (&self.mode, frame) {
            (GuardMode::Serve { guard, attempt }, GuardFrame::Ready(receipt)) => {
                self.register(guard, attempt, receipt)
            }
            (GuardMode::Reclaim { nonce }, GuardFrame::Reclaimed(reply)) => {
                self.receive_reply(nonce, reply);
                None
            }
            (_, GuardFrame::Error(error)) => {
                self.receive_error(error);
                None
            }
            _ => None,
        }
    }

    fn ssh_output<'a>(&self, line: &'a str) -> Option<Output<'a>> {
        let mut progress = self.progress.lock().unwrap_or_else(|p| p.into_inner());
        let clean = line.trim();
        if clean.starts_with("debug1: Sending command:") {
            progress.debug_command = !clean.ends_with('\'');
            return None;
        }
        if progress.debug_command {
            if clean.starts_with("debug")
                || clean.starts_with("ssh:")
                || clean.starts_with("client_loop:")
                || clean.starts_with("Connection ")
                || clean.starts_with("kex_")
                || clean.contains("Permission denied")
            {
                progress.debug_command = false;
            } else {
                if clean.ends_with('\'') {
                    progress.debug_command = false;
                }
                return None;
            }
        }
        Some(Output::SshLine(line))
    }

    fn register(
        &self,
        guard: &ManagedGuard,
        attempt: &GuardAttempt,
        receipt: GuardReceipt,
    ) -> Option<Output<'static>> {
        let mut progress = self.progress.lock().unwrap_or_else(|p| p.into_inner());
        if progress.ready || progress.failure.is_some() {
            return None;
        }
        if let Err(message) = guard.remember(attempt, receipt) {
            progress.failure = Some(Fatal::Other(message));
            return None;
        }
        progress.ready = true;
        progress.debug_command = false;
        Some(Output::GuardReady)
    }

    fn receive_reply(&self, nonce: &str, reply: ReclaimReply) {
        if reply.nonce != nonce {
            self.fail(Fatal::Other("旧隧道回收请求已失效，请重试。".into()));
        } else {
            self.progress
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .reply = Some(reply.result);
        }
    }

    fn receive_error(&self, error: GuardError) {
        let nonce = match &self.mode {
            GuardMode::Serve { attempt, .. } => &attempt.nonce,
            GuardMode::Reclaim { nonce } => nonce,
        };
        if error.nonce != *nonce {
            return;
        }
        let failure = if error.code == "unsupported" {
            Fatal::GuardUnavailable(
                "服务器需要 Linux 5.3 以上及 Python 3.9 以上才能启用隧道自动恢复。".into(),
            )
        } else {
            Fatal::Other("无法核验隧道恢复身份，等待旧监听释放后重试。".into())
        };
        self.fail(failure);
    }

    fn fail(&self, failure: Fatal) {
        self.progress
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .failure
            .get_or_insert(failure);
    }

    fn failure(&self) -> Option<Fatal> {
        self.progress
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .failure
            .clone()
    }

    fn pending(&self) -> bool {
        let progress = self.progress.lock().unwrap_or_else(|p| p.into_inner());
        match self.mode {
            GuardMode::Serve { .. } => !progress.ready,
            GuardMode::Reclaim { .. } => progress.reply.is_none(),
        }
    }

    pub fn reply(&self) -> Option<ReclaimResult> {
        self.progress
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .reply
    }

    fn pulse(&self, writer: &mut dyn Write, now: Instant) -> std::io::Result<()> {
        if self.stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let GuardMode::Serve { attempt, .. } = &self.mode else {
            return Ok(());
        };
        let mut progress = self.progress.lock().unwrap_or_else(|p| p.into_inner());
        if !progress.ready || progress.failure.is_some() {
            return Ok(());
        }
        if progress
            .last_heartbeat
            .is_some_and(|last| now.duration_since(last) < HEARTBEAT_INTERVAL)
        {
            return Ok(());
        }
        writer.write_all(&attempt.heartbeat())?;
        writer.flush()?;
        progress.last_heartbeat = Some(now);
        #[cfg(test)]
        self.heartbeat_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[derive(Clone)]
struct SharedWriter(Arc<Mutex<Box<dyn Write + Send>>>);

impl Write for SharedWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).write(data)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).flush()
    }
}

pub(super) fn run(
    program: &PathBuf,
    args: &[String],
    creds: PendingCreds,
    stop: &Arc<AtomicBool>,
    killer: &Mutex<Option<Killer>>,
    guard: Option<Arc<GuardRun>>,
    emit: impl FnMut(Output<'_>) + Send + 'static,
) -> Option<Fatal> {
    if stop.load(Ordering::SeqCst) {
        return None;
    }
    let OpenPty {
        master,
        mut child,
        reader,
        mut writer,
    } = match open_pty(program, args) {
        Ok(process) => process,
        Err(failure) => return Some(failure),
    };
    *killer.lock().unwrap_or_else(|p| p.into_inner()) = Some(child.clone_killer());
    let read_thread = spawn_output(
        reader,
        writer.clone(),
        creds,
        child.clone_killer(),
        guard.clone(),
        emit,
    );
    let (exit_code, wait_failure) =
        monitor(child.as_mut(), &mut writer, stop, &guard, &read_thread);
    *killer.lock().unwrap_or_else(|p| p.into_inner()) = None;
    std::thread::sleep(std::time::Duration::from_millis(200));
    // Closing the PTY master before joining is required for Windows ConPTY to deliver EOF.
    drop(master);
    let reader_failure = read_thread
        .join()
        .unwrap_or_else(|_| Some(Fatal::Other("隧道输出读取已停止，请重试。".into())));
    let guard_failure = guard.as_ref().and_then(|guard| guard.failure());
    let unavailable = (exit_code == Some(127) && guard.is_some()).then(|| {
        Fatal::GuardUnavailable("服务器没有可用的 Python 3，请检查服务器环境后重试。".into())
    });
    reader_failure
        .or(guard_failure)
        .or(wait_failure)
        .or(unavailable)
}

struct OpenPty {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    reader: Box<dyn Read + Send>,
    writer: SharedWriter,
}

fn open_pty(program: &PathBuf, args: &[String]) -> Result<OpenPty, Fatal> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 400,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| Fatal::Other(format!("打开 PTY 失败：{error}")))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| Fatal::Other(format!("获取 PTY 读取端失败：{error}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| Fatal::Other(format!("获取 PTY 写入端失败：{error}")))?;
    let mut command = CommandBuilder::new(program);
    command.args(args);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| Fatal::Other(format!("启动 ssh 失败：{error}")))?;
    drop(pair.slave);
    Ok(OpenPty {
        master: pair.master,
        child,
        reader,
        writer: SharedWriter(Arc::new(Mutex::new(writer))),
    })
}

fn spawn_output(
    reader: Box<dyn Read + Send>,
    writer: SharedWriter,
    creds: PendingCreds,
    killer: Killer,
    guard: Option<Arc<GuardRun>>,
    mut emit: impl FnMut(Output<'_>) + Send + 'static,
) -> std::thread::JoinHandle<Option<Fatal>> {
    std::thread::spawn(move || {
        read_loop(reader, Box::new(writer), creds, killer, |line| {
            if let Some(guard) = &guard {
                if let Some(output) = guard.consume(line) {
                    emit(output);
                }
            } else {
                emit(Output::SshLine(line));
            }
        })
    })
}

fn check_guard(guard: &Option<Arc<GuardRun>>, writer: &mut dyn Write, deadline: Instant) -> bool {
    let Some(guard) = guard else {
        return false;
    };
    if Instant::now() >= deadline && guard.pending() {
        guard.fail(Fatal::Other(
            "隧道恢复检查暂时没有响应，正在等待重新连接。".into(),
        ));
    }
    if let Err(error) = guard.pulse(writer, Instant::now()) {
        guard.fail(Fatal::Other(format!("无法发送隧道心跳：{error}")));
    }
    guard.failure().is_some()
}

fn monitor(
    child: &mut dyn Child,
    writer: &mut dyn Write,
    stop: &AtomicBool,
    guard: &Option<Arc<GuardRun>>,
    reader: &std::thread::JoinHandle<Option<Fatal>>,
) -> (Option<u32>, Option<Fatal>) {
    let deadline = Instant::now() + GUARD_START_TIMEOUT;
    let mut wait_failure = None;
    let mut reader_ended = None::<Instant>;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(exit)) => break Some(exit.exit_code()),
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                wait_failure = Some(Fatal::Other(format!("等待 ssh 退出失败：{error}")));
                break None;
            }
        }
        if guard.is_some() && reader.is_finished() {
            reader_ended.get_or_insert_with(Instant::now);
        }
        let lost_output = reader_ended
            .is_some_and(|ended| ended.elapsed() >= std::time::Duration::from_millis(500));
        if lost_output && !stop.load(Ordering::SeqCst) {
            wait_failure.get_or_insert_with(|| {
                Fatal::Other("隧道输出通道已关闭，正在等待重新连接。".into())
            });
        }
        if stop.load(Ordering::SeqCst) || lost_output || check_guard(guard, writer, deadline) {
            let _ = child.kill();
        }
        // Both normal operation and a failing producer yield at a fixed, bounded polling rate.
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    (exit_code, wait_failure)
}

#[cfg(test)]
#[path = "ssh_tunnel_process_tests.rs"]
mod tests;
