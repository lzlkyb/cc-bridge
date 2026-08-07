//! 通用 MCP 桥：把本机已有的任意 stdio MCP server 代理给远程 Claude Code。
//!
//! 方案：`docs/mcp-bridge-step1-plan.md`；多项目支持见
//! `design/外挂MCP桥-多项目支持-设计稿.html`。子模块：
//!
//! - `spawn`：跨平台命令解析（PATHEXT）+ 进程树包装（JobObject / 进程组）
//! - `client`：stdio JSON-RPC 协议层
//! - `config`：`ExternalMcpServer` 结构、名字校验、指纹
//! - `manifest`：工具清单的抓取与持久化（运行时发现零进程启动）
//! - `session`：进程 + 协议合体，关闭序列（先关 stdin，JobObject 兜底）
//! - `import`：从用户已有的 MCP 客户端配置导入
//!
//! `client` 与 `spawn` **故意不相识**：前者只要一对 `Read`/`Write`，后者只负责把进程拉起来。
//! 好处是协议逻辑能用内存管道完整单测——不依赖本机装了任何真实 MCP server，CI 上照跑；
//! 而真需要进程的那几条（关 stdin 优雅退 / JobObject 兜底）单独验。
//!
//! 🔴 这里的代码**不得为任何具体 server 写分支**。codegraph / filesystem 只能出现在
//! 注释与测试里作为例子，一旦出现 `if server == "xxx"` 就是跑偏了（见方案 §目标）。

pub mod client;
pub mod config;
pub mod import;
pub mod manifest;
pub mod session;
pub mod spawn;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use config::ExternalMcpServer;
use session::Session;

/// 启动失败后的最小重试间隔。
///
/// 没它的话，一个没装的 server 会让**每一次**工具调用都去 spawn 一遍，
/// 在 Windows 上那是真实的进程创建开销（而且每次都失败）。
const RETRY_BACKOFF: Duration = Duration::from_secs(30);

/// 握手 / 单次调用的默认超时。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// 空闲回收阈值。先写死，不做成配置项——多一个旋钮不如先看看有没人抱怨。
pub const IDLE_TTL: Duration = Duration::from_secs(15 * 60);

/// 连接池的键。
///
/// 🔴 **带 cwd 是多项目支持的全部关键**：stdio server 的工作目录在启动那一刻
/// 就定死了，所以“一个 server 服务多个项目”只能是**一个项目一个进程**。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionKey {
    pub name: String,
    /// 生效的工作目录。`None` = 继承 cc-bridge 自己的。
    pub cwd: Option<PathBuf>,
}

/// 池里的一项。`last_used` 只为惰性回收服务。
struct Pooled {
    session: Arc<Mutex<Session>>,
    last_used: Instant,
}

/// 连接池。
///
/// **懒启动**（方案 §7.3）：只有真的要调工具时才拉起那一个 server。
/// 列工具走持久化的 manifest，**零进程启动**——否则 N 个 server 下首次调用就会
/// 把它们全部冷启动一遍。
///
/// **为何是同步的 `std::sync::Mutex`**：下面的活全是阻塞 IO（管道读写 / 等进程），
/// 调用方本就应该用 `spawn_blocking` 把它扔出异步运行时——跟 `run_command` 同一套做法。
#[derive(Default)]
pub struct McpBridge {
    /// 每个（server, cwd）一把锁：同一个的调用排队（stdin/stdout 是单一流），
    /// **不同的互不影响**。
    sessions: Mutex<HashMap<SessionKey, Pooled>>,
    /// 上次启动失败的时间与原因，用于退避。
    ///
    /// 同样按 `SessionKey` 记：否则 A 项目启动失败（比如那个目录根本没建索引）
    /// 会把 B 项目一起退避掉 30 秒。
    failures: Mutex<HashMap<SessionKey, (Instant, String)>>,
}

impl McpBridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// 算出生效的键。`cwd` 为远程指定的覆盖值，没传就用配置里管理员定的。
    ///
    /// 两者指向同一目录时得到同一把键，从而复用同一个进程——
    /// 不合并的话，远程“好心”把默认目录显式传一遍就会多起一个进程。
    fn key(spec: &ExternalMcpServer, cwd: Option<&Path>) -> SessionKey {
        let effective = cwd
            .map(|p| p.to_path_buf())
            .or_else(|| spec.cwd.as_ref().map(PathBuf::from));
        SessionKey {
            name: spec.name.clone(),
            cwd: effective,
        }
    }

    /// 拿一个可用会话，没有就启一个。`cwd` 为远程指定的工作目录（已经校过白名单）。
    pub fn session(
        &self,
        spec: &ExternalMcpServer,
        cwd: Option<&Path>,
        timeout: Duration,
    ) -> Result<Arc<Mutex<Session>>, String> {
        // 顺手回收——零定时器、零常驻线程（见本文件末尾 `sweep_idle` 的说明）。
        self.sweep_idle();

        let key = Self::key(spec, cwd);
        if let Some(s) = self.touch(&key) {
            return Ok(s);
        }
        if let Some(err) = self.in_backoff(&key) {
            return Err(err);
        }

        // 🔴 启动期间**不持外层锁**：handshake 最长能跑到 timeout，
        // 持锁会把其他 server 的调用一起卡死。
        let started = session::connect(spec, key.cwd.as_deref(), timeout)
            .inspect_err(|e| self.note_failure_key(&key, e))?;

        let arc = Arc::new(Mutex::new(started));
        let mut map = self.sessions.lock().map_err(|_| lock_poisoned())?;
        // 并发竞走：别人先插好了就用他的，我们这个直接关掉，不能漏个进程。
        if let Some(existing) = map.get(&key).map(|p| Arc::clone(&p.session)) {
            // 先把 Arc 克隆出来再放锁：否则 `existing` 借着 `map`，没法在关进程前释锁，
            // 而 shutdown 最长要等 3s，持着外层锁等会把别的 server 一起卡住。
            drop(map);
            if let Ok(mut s) = arc.lock() {
                s.shutdown(session::GRACE);
            }
            return Ok(existing);
        }
        map.insert(
            key.clone(),
            Pooled {
                session: Arc::clone(&arc),
                last_used: Instant::now(),
            },
        );
        drop(map);
        self.clear_failure_key(&key);
        Ok(arc)
    }

    /// 只摘掉**这一个**（server, cwd）会话。连接中毒时用。
    ///
    /// 🔴 不能拿 `drop_server` 顶替：A 项目的连接中毒了，
    /// 不该把 B 项目健康的会话一起关掉。
    pub fn drop_one(&self, spec: &ExternalMcpServer, cwd: Option<&Path>) {
        let key = Self::key(spec, cwd);
        let taken = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut m| m.remove(&key).map(|p| (key, p.session)));
        close_all(taken.into_iter().collect(), "连接已中毒，已摘掉");
    }

    /// 把一个 server 的**全部** cwd 变体从池里摸掉并关闭。
    ///
    /// 🔴 必须是全部。只关默认那一个的后果不是“少关一个进程”：用户把某个 server
    /// **停用**后，它在其它项目上的 N 个进程还在跑，而界面上写着已停用。
    ///
    /// 调用时机：停用、删除、改启动参数、总开关关闭。下次调用会重建。
    pub fn drop_server(&self, name: &str) {
        let taken: Vec<(SessionKey, Arc<Mutex<Session>>)> = match self.sessions.lock() {
            Ok(mut m) => {
                let keys: Vec<SessionKey> = m.keys().filter(|k| k.name == name).cloned().collect();
                keys.into_iter()
                    .filter_map(|k| m.remove(&k).map(|p| (k, p.session)))
                    .collect()
            }
            Err(_) => return,
        }; // 锁在这里释放，才能安全地去关进程（最长 3s）
        close_all(taken, "已关闭");
    }

    /// 关掉所有会话（应用退出 / 总开关关闭时）。
    pub fn shutdown_all(&self) {
        let all: Vec<_> = self
            .sessions
            .lock()
            .map(|mut m| m.drain().map(|(k, p)| (k, p.session)).collect::<Vec<_>>())
            .unwrap_or_default();
        close_all(all, "已关闭");
    }

    /// 回收空闲超过 `IDLE_TTL` 的会话。
    ///
    /// **惰性回收，不开后台任务**（CLAUDE.md §8.1）：在 `session()` 与设置页列表里
    /// 顺手跑一遍。零定时器、零常驻线程，扫描本身就是遍历一个最多几十项的 map。
    ///
    /// **已知缺陷**：没人调用就不会扫。用完放着不管的话，进程会活到下次调用
    /// 或应用退出。代价是几个闲置进程，换来零后台任务——这个交换是故意的。
    pub fn sweep_idle(&self) {
        let expired: Vec<(SessionKey, Arc<Mutex<Session>>)> = match self.sessions.lock() {
            Ok(mut m) => {
                let dead: Vec<SessionKey> = m
                    .iter()
                    .filter(|(_, p)| p.last_used.elapsed() >= IDLE_TTL)
                    .map(|(k, _)| k.clone())
                    .collect();
                dead.into_iter()
                    .filter_map(|k| m.remove(&k).map(|p| (k, p.session)))
                    .collect()
            }
            Err(_) => return,
        }; // 同 `drop_server`：先放锁再关进程
        close_all(
            expired,
            &format!("空闲超过 {} 分钟，已回收", IDLE_TTL.as_secs() / 60),
        );
    }

    /// 该 server 当前活着的工作目录，供设置页显示「运行中：N 个目录」。
    ///
    /// 不显示的话，用户不知道自己开了几个进程。
    pub fn live_cwds(&self, name: &str) -> Vec<Option<PathBuf>> {
        self.sessions
            .lock()
            .map(|m| {
                m.keys()
                    .filter(|k| k.name == name)
                    .map(|k| k.cwd.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 上次启动失败的原因，供设置页显示 `failed` 态。
    ///
    /// 多 cwd 变体时取**最新的那一条**：设置页是按 server 展示的，
    /// 而“某个项目起不来”也是用户应该看到的信息。
    ///
    /// **只活在进程内**：重启后回到「未探测」。这是诚实的——重启后那个失败到底还在不在，
    /// 谁也不知道，落盘反而会让用户看着一条早就修好的旧错误。
    pub fn last_failure(&self, name: &str) -> Option<String> {
        let map = self.failures.lock().ok()?;
        map.iter()
            .filter(|(k, _)| k.name == name)
            .max_by_key(|(_, (at, _))| *at)
            .map(|(_, (_, e))| e.clone())
    }

    /// 记一笔失败。
    ///
    /// `pub` 是给 `mcp_bridge_probe` 用的：它不走连接池（探完就关，不留常驻进程），
    /// 不手动记的话，探测失败后列表一刷新那行就变回「未探测」，错误原文没了。
    pub fn note_failure(&self, spec: &ExternalMcpServer, cwd: Option<&Path>, err: &str) {
        self.note_failure_key(&Self::key(spec, cwd), err);
    }

    /// 抹掉该 server **全部** cwd 变体的失败记录。
    ///
    /// 探测成功 / 改了启动参数后必须清掉，否则那行会一直挂着一条已经修好的旧错误。
    pub fn clear_failures(&self, name: &str) {
        if let Ok(mut m) = self.failures.lock() {
            m.retain(|k, _| k.name != name);
        }
    }

    fn touch(&self, key: &SessionKey) -> Option<Arc<Mutex<Session>>> {
        let mut map = self.sessions.lock().ok()?;
        let p = map.get_mut(key)?;
        p.last_used = Instant::now();
        Some(Arc::clone(&p.session))
    }

    fn in_backoff(&self, key: &SessionKey) -> Option<String> {
        let map = self.failures.lock().ok()?;
        let (at, err) = map.get(key)?;
        (at.elapsed() < RETRY_BACKOFF).then(|| {
            format!(
                "{err}\n（{}s 内不会重试，避免反复启进程）",
                RETRY_BACKOFF.as_secs()
            )
        })
    }

    fn note_failure_key(&self, key: &SessionKey, err: &str) {
        if let Ok(mut m) = self.failures.lock() {
            m.insert(key.clone(), (Instant::now(), err.to_string()));
        }
    }

    fn clear_failure_key(&self, key: &SessionKey) {
        if let Ok(mut m) = self.failures.lock() {
            m.remove(key);
        }
    }
}

/// 关掉一批**已经从池里摘出来**的会话。
///
/// 🔴 调用前必须已经释放 `sessions` 锁：`shutdown` 最长要等 3s（先关 stdin
/// 让对方自己退），持着池锁等会把其它 server 的调用一起卡住。
fn close_all(taken: Vec<(SessionKey, Arc<Mutex<Session>>)>, why: &str) {
    for (k, s) in taken {
        if let Ok(mut s) = s.lock() {
            let how = s.shutdown(session::GRACE);
            match &k.cwd {
                Some(d) => log::info!(
                    "外挂 MCP server {}（{}）{why}（{how:?}）",
                    k.name,
                    d.display()
                ),
                None => log::info!("外挂 MCP server {} {why}（{how:?}）", k.name),
            }
        }
    }
}

fn lock_poisoned() -> String {
    "外挂 MCP 连接池锁已中毒（有线程在持锁时 panic）".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, cwd: Option<&str>) -> ExternalMcpServer {
        ExternalMcpServer {
            name: name.into(),
            transport: "stdio".into(),
            command: "x".into(),
            args: vec![],
            env: vec![],
            cwd: cwd.map(|s| s.to_string()),
            enabled: true,
            allow_remote_cwd: false,
        }
    }

    /// 远程没传 cwd 时用配置里的，传了就用传的。
    #[test]
    fn key_prefers_override_then_config() {
        let s = spec("a", Some("C:/cfg"));
        assert_eq!(McpBridge::key(&s, None).cwd, Some(PathBuf::from("C:/cfg")));
        assert_eq!(
            McpBridge::key(&s, Some(Path::new("C:/other"))).cwd,
            Some(PathBuf::from("C:/other"))
        );
        assert_eq!(McpBridge::key(&spec("a", None), None).cwd, None);
    }

    /// 🔴 远程“好心”把默认目录显式传一遍时，不得多起一个进程。
    #[test]
    fn explicit_cwd_equal_to_config_shares_one_session() {
        let s = spec("a", Some("C:/cfg"));
        assert_eq!(
            McpBridge::key(&s, None),
            McpBridge::key(&s, Some(Path::new("C:/cfg")))
        );
    }

    /// 不同项目 = 不同键 = 不同进程。
    #[test]
    fn different_cwd_is_a_different_session() {
        let s = spec("a", None);
        assert_ne!(
            McpBridge::key(&s, Some(Path::new("C:/p1"))),
            McpBridge::key(&s, Some(Path::new("C:/p2")))
        );
    }

    /// 🔴 失败退避按键隔离：A 项目起不来不能拖累 B 项目。
    #[test]
    fn backoff_is_per_cwd_not_per_server() {
        let pool = McpBridge::new();
        let s = spec("a", None);
        pool.note_failure(&s, Some(Path::new("C:/p1")), "没建索引");
        assert!(pool
            .in_backoff(&McpBridge::key(&s, Some(Path::new("C:/p1"))))
            .is_some());
        assert!(
            pool.in_backoff(&McpBridge::key(&s, Some(Path::new("C:/p2"))))
                .is_none(),
            "另一个项目不应该被连坐"
        );
    }

    /// 清失败是按 server 清全部变体的（改了启动参数后旧错误全作废）。
    #[test]
    fn clear_failures_wipes_every_cwd_variant() {
        let pool = McpBridge::new();
        let s = spec("a", None);
        pool.note_failure(&s, Some(Path::new("C:/p1")), "e1");
        pool.note_failure(&s, Some(Path::new("C:/p2")), "e2");
        pool.note_failure(&spec("b", None), None, "别人的");
        pool.clear_failures("a");
        assert!(pool.last_failure("a").is_none());
        assert!(pool.last_failure("b").is_some(), "不得误伤其它 server");
    }
}
