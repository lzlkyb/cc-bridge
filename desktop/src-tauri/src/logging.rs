//! 主程序日志落盘。
//!
//! ## 为什么非做不可
//!
//! release 版是 `windows_subsystem = "windows"`，没有控制台；`env_logger` 默认写 stderr
//! （Windows 上落到 OutputDebugString），用户机器上没人接。于是「偶发白屏」这类反馈到手
//! 时零信息——既不知道白屏前一秒后端在干什么，也不知道白屏时后端是否还活着。
//!
//! ## 边界
//!
//! 只做三件事：**算目录**、**按大小滚动**、**把 logger 的管道接过去**。不做日志查看界面，
//! 也不引 `tauri-plugin-log`：为了写一个文件扩一整条插件依赖链不划算，而这里需要的
//! 「超限就切、只留最近几份」二十行就能写完，且行为完全可控。
//!
//! ## 目录怎么来的
//!
//! `env_logger` 必须在 `main` 最开头初始化（要接住 setup 之前就可能出现的 panic 日志），
//! 那时还没有 `AppHandle`，拿不到 `app_data_dir()`。所以按 Tauri 同一套平台规则自己拼：
//! Windows 是 `%APPDATA%\<identifier>`，macOS 是 `~/Library/Application Support/<identifier>`，
//! 其余是 `$XDG_DATA_HOME/<identifier>`（或 `~/.local/share`）。
//!
//! 拼错就等于「日志写了但用户找不到」，所以 `setup` 里拿到真实的 `app_data_dir()` 之后
//! 必须调一次 [`confirm_dir`]：不一致会翻成 `warn`，至少能在日志里留下痕迹。

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 单个日志文件的上限。一条 `env_logger` 记录约 150~250 字节，2MB 能存近万条，
/// 足够覆盖一次「白屏 → 重启」的现场；再大只会让用户目录无谓膨胀。
const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// 保留的旧文件份数：`app.log` + `app.1.log` + `app.2.log`，合计最多 6MB。
const KEEP_FILES: usize = 2;

/// 日志文件名。固定不随日期变——按天分会同时留一堆文件，而用户只会复制一个文件发过来。
pub const FILE_NAME: &str = "app.log";

/// 界面异常专用文件。
///
/// **为什么要与 `app.log` 分开**：主日志记的是整机行为，隧道重连、MCP 报错都会往里写；
/// 一旦某个后台路径高频 `warn`，2MB 很快被冲掉——恰好把白屏前那几十行挤没了。
/// 界面异常量很小（有限流），单独一份就能保证「白屏现场」不会先被别的东西覆盖。
pub const UI_FILE_NAME: &str = "ui.log";

/// 本次进程实际写入的目录，供 [`confirm_dir`] 与测试读取。
static ACTIVE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 界面异常文件句柄。写入频率低（前端侧有限流），独立锁不与主日志抢。
static UI_FILE: Mutex<Option<RollingFile>> = Mutex::new(None);

/// 应用数据目录下的日志目录。
pub fn logs_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("logs")
}

/// 按平台规则推导应用数据目录（与 Tauri `app_data_dir()` 的取值一致）。
///
/// `main` 里没有 `AppHandle`，只能自己算；`setup` 里用 [`confirm_dir`] 复核。
pub fn default_app_data_dir(identifier: &str) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(base) = std::env::var("APPDATA") {
            return PathBuf::from(base).join(identifier);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(identifier);
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Ok(base) = std::env::var("XDG_DATA_HOME") {
            return PathBuf::from(base).join(identifier);
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".local/share").join(identifier);
        }
    }
    // 环境变量都没有：退成当前目录。日志写不进去也不该拦住启动，`init` 会回落到 stderr。
    PathBuf::from(".").join(identifier)
}

/// 初始化日志：文件 + （调试构建下）stderr 双写。
///
/// 文件名带滚动，写失败时**不 panic、不拦启动**——一个诊断设施把应用拖死是最糟的交换。
pub fn init(app_data_dir: &Path) {
    let dir = logs_dir(app_data_dir);
    let file = match RollingFile::open(&dir, FILE_NAME, MAX_BYTES) {
        Ok(file) => {
            let _ = ACTIVE_DIR.set(dir.clone());
            Some(file)
        }
        Err(error) => {
            // 此刻 logger 还没就绪，只能走 stderr；release 下看不见，但至少不是静默失败。
            eprintln!("日志目录不可用（{}）：{error}", dir.display());
            None
        }
    };

    // 界面异常独立一份；打不开也不影响主日志。
    if let Ok(ui) = RollingFile::open(&dir, UI_FILE_NAME, MAX_BYTES) {
        *UI_FILE.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(ui);
    }

    let mut builder = env_logger::Builder::from_env(
        env_logger::Env::default()
            .default_filter_or("error,mcp::probe=info,cc_bridge_desktop::logging=info"),
    );
    if let Some(file) = file {
        // dev 下仍然要能在终端看到，所以是双写而不是「只写文件」。
        builder.target(env_logger::Target::Pipe(Box::new(Tee {
            file,
            stderr: cfg!(debug_assertions),
        })));
    }
    builder.init();
    if let Some(dir) = ACTIVE_DIR.get() {
        log::info!("日志文件：{}", dir.join(FILE_NAME).display());
        log::info!("界面异常日志：{}", dir.join(UI_FILE_NAME).display());
    }
}

/// 往界面异常日志里追加一行（带本地时间戳）。
///
/// 不经过 `env_logger`：那条链上挂着全局级别过滤与唯一 target，界面证据不该被
/// 后台的高频日志挤掉，也不该因为有人调高过滤级别就消失。
pub fn note_ui(level: &str, message: &str) {
    let mut guard = UI_FILE.lock().unwrap_or_else(|poison| poison.into_inner());
    let Some(file) = guard.as_mut() else {
        return;
    };
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    // 一条一 flush：白屏后进程可能被杀，缓冲里的最后一行恰好是最有价值的那行。
    let _ = writeln!(file, "[{stamp}] {level} {message}");
    let _ = file.flush();
}

/// 用 `setup` 里拿到的真实 `app_data_dir()` 复核目录推导是否正确。
///
/// 不一致意味着日志正在写一个用户「不知道在哪」的位置——用户反馈问题时我们就会要错文件。
pub fn confirm_dir(app_data_dir: &Path) {
    let actual = logs_dir(app_data_dir);
    match ACTIVE_DIR.get() {
        Some(active) if *active == actual => {}
        Some(active) => log::warn!(
            "日志目录与预期不一致：实际写入 {}，Tauri 认为应在 {}；请按前者取日志",
            active.display(),
            actual.display()
        ),
        None => log::warn!("日志未落盘（初始化失败），本轮前端上报只会进 stderr"),
    }
}

/// 双写：文件为主，调试构建额外写 stderr。
struct Tee {
    file: RollingFile,
    stderr: bool,
}

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.file.write(buf)?;
        if self.stderr {
            // stderr 写失败（管道已关闭等）不能影响文件那条路。
            let _ = io::stderr().write_all(buf);
        }
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()?;
        if self.stderr {
            let _ = io::stderr().flush();
        }
        Ok(())
    }
}

/// 带大小滚动的追加写文件。
struct RollingFile {
    dir: PathBuf,
    name: String,
    file: File,
    written: u64,
    max_bytes: u64,
}

impl RollingFile {
    fn open(dir: &Path, name: &str, max_bytes: u64) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(name))?;
        // 按真实长度起算：进程重启不能把「已经很大」的文件当成空文件，否则永远不滚。
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            dir: dir.to_path_buf(),
            name: name.to_string(),
            file,
            written,
            max_bytes,
        })
    }

    /// `app.log` → `app.1.log` → `app.2.log`，最旧的一份丢弃。
    ///
    /// 必须从大编号往小改：反过来的话 `app.1.log → app.2.log` 会覆盖掉还没挪走的旧 `.2`。
    fn rotate(&mut self) -> io::Result<()> {
        let path_of = |index: usize| -> PathBuf {
            if index == 0 {
                self.dir.join(&self.name)
            } else {
                // 用 strip_suffix 而不是 trim_end_matches：后者会把 `a.log.log` 也削成 `a`。
                let stem = self.name.strip_suffix(".log").unwrap_or(&self.name);
                self.dir.join(format!("{stem}.{index}.log"))
            }
        };
        // Windows 上 rename 不能覆盖已存在的目标，最旧那份先删。
        let _ = fs::remove_file(path_of(KEEP_FILES));
        for index in (2..=KEEP_FILES).rev() {
            let _ = fs::rename(path_of(index - 1), path_of(index));
        }
        let _ = fs::rename(path_of(0), path_of(1));
        // 旧句柄指向已被改名的文件，必须重新打开，否则后续内容仍写进 `app.1.log`。
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path_of(0))?;
        self.written = 0;
        Ok(())
    }
}

impl Write for RollingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.written.saturating_add(buf.len() as u64) > self.max_bytes && self.rotate().is_err()
        {
            // 滚动失败（文件被占用 / 无权限）：继续往同一个文件追加，但把计数归零，
            // 否则之后每一次 write 都会再试一次重命名。宁可文件超限，也不能让日志停摆。
            self.written = 0;
        }
        let written = self.file.write(buf)?;
        self.written = self.written.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试专用临时目录：进程 id + 序号，避免并行用例互相踩。
    fn temp_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ccb-logging-{}-{}-{tag}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn rolls_when_the_file_passes_the_limit() {
        let dir = temp_dir("roll");
        let mut file = RollingFile::open(&dir, FILE_NAME, 32).expect("open");

        // 每条 10 字节，第 4 条触发滚动（已写 30 + 10 > 32）。
        for _ in 0..8 {
            file.write_all(b"0123456789").expect("write");
        }
        file.flush().expect("flush");

        assert!(dir.join(FILE_NAME).exists(), "当前文件必须仍在");
        assert!(
            dir.join("app.1.log").exists(),
            "超限后必须出现 app.1.log（文件名去掉 .log 再加序号）"
        );
        // 滚动后新文件从空开始，所以最新一份只有剩下的条目。
        let current = read(&dir.join(FILE_NAME));
        assert!(
            (current.len() as u64) <= 32,
            "滚过之后当前文件不应继续超限，实际 {}",
            current.len()
        );
        // 旧内容不能丢：三份加起来必须是全部写入量。
        // 8 条会触发两次滚动，第一批已被挤到 app.2.log，所以不能只数两份。
        let total: usize = [FILE_NAME, "app.1.log", "app.2.log"]
            .iter()
            .map(|name| read(&dir.join(name)).len())
            .sum();
        assert_eq!(total, 80, "滚动不得丢内容");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn old_files_are_bounded_and_dropped_from_the_tail() {
        let dir = temp_dir("keep");
        let mut file = RollingFile::open(&dir, FILE_NAME, 16).expect("open");
        for _ in 0..40 {
            file.write_all(b"abcdefghij").expect("write");
        }
        file.flush().expect("flush");

        // 只保留 app.log / app.1.log / app.2.log，更旧的必须被删掉。
        assert!(dir.join("app.2.log").exists(), "第二份旧文件应保留");
        assert!(
            !dir.join("app.3.log").exists(),
            "超出 KEEP_FILES 的旧文件必须被丢弃，否则日志会无限增长"
        );
        let kept: u64 = [FILE_NAME, "app.1.log", "app.2.log"]
            .iter()
            .map(|name| read(&dir.join(name)).len() as u64)
            .sum();
        assert!(kept <= 16 * 3, "留存总量应受上限约束，实际 {kept}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reopen_keeps_appending_instead_of_truncating() {
        let dir = temp_dir("append");
        {
            let mut file = RollingFile::open(&dir, FILE_NAME, 1024).expect("open");
            file.write_all(b"first-run").expect("write");
            file.flush().expect("flush");
        }
        {
            let mut file = RollingFile::open(&dir, FILE_NAME, 1024).expect("reopen");
            // 重新打开时若用了 truncate，上一轮启动的现场就没了。
            assert_eq!(file.written, 9, "重启后长度必须按真实文件大小起算");
            file.write_all(b"-second").expect("write");
        }
        assert_eq!(read(&dir.join(FILE_NAME)), "first-run-second");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_dir_follows_the_platform_rule() {
        // 只校验「拼上了 identifier」，避免绑定具体机器路径。
        let dir = default_app_data_dir("com.example.test");
        assert!(
            dir.ends_with("com.example.test"),
            "应用数据目录必须以 identifier 结尾，实际 {}",
            dir.display()
        );
    }
}
