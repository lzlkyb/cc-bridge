//! P1 远程访问安全：401 连续失败封禁（内存态）。
//!
//! 设计（proposals/p1_https_tls_plan.md §4）：
//! - 连续 `threshold` 次鉴权失败 → 该 IP 后续请求直接 429，窗口 `window` 过后自动解封。
//! - 认证成功清零该 IP 计数（防误伤：改对 token 立刻恢复）。
//! - **内存态、重启清零**：防爆破够用；不做 fail2ban 级持久封禁（文档已诚实说明）。
//! - 仅在绑定 `0.0.0.0`（跨网可达）时启用——127.0.0.1 场景无意义且可能误伤本地代理。
//!
//! 与限流的区别：限流是「合法身份的请求速率」，封禁是「连续猜错 token 的 IP 隔离」，
//! 两者正交，封禁检查必须发生在鉴权之前（不进鉴权逻辑，防爆破 + 省校验开销）。

use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;

#[derive(Debug)]
struct Entry {
    fails: u32,
    banned_until: Option<Instant>,
    last_fail: Instant,
}

#[derive(Debug)]
pub struct BanRegistry {
    inner: DashMap<IpAddr, Entry>,
    enabled: Arc<std::sync::atomic::AtomicBool>,
    threshold: Arc<std::sync::atomic::AtomicU32>,
    window: Arc<std::sync::atomic::AtomicU64>, // 分钟
}

impl BanRegistry {
    pub fn new(enabled: bool, threshold: u32, window_min: u64) -> Self {
        Self {
            inner: DashMap::new(),
            enabled: Arc::new(std::sync::atomic::AtomicBool::new(enabled)),
            threshold: Arc::new(std::sync::atomic::AtomicU32::new(threshold.max(1))),
            window: Arc::new(std::sync::atomic::AtomicU64::new(window_min.max(1))),
        }
    }

    /// 运行期热更新（配置变更走 restart_server 链路时同步调用）。
    pub fn update_policy(&self, enabled: bool, threshold: u32, window_min: u64) {
        self.enabled
            .store(enabled, std::sync::atomic::Ordering::Relaxed);
        self.threshold
            .store(threshold.max(1), std::sync::atomic::Ordering::Relaxed);
        self.window
            .store(window_min.max(1), std::sync::atomic::Ordering::Relaxed);
    }

    /// 放行判断：true = 放行，false = 该 IP 处于封禁窗口内（调用方直接 429）。
    pub fn check(&self, ip: IpAddr) -> bool {
        if !self.enabled.load(std::sync::atomic::Ordering::Relaxed) {
            return true;
        }
        let Some(entry) = self.inner.get(&ip) else {
            return true;
        };
        match entry.banned_until {
            Some(until) if Instant::now() < until => false,
            Some(_) => {
                // 封禁窗口已过：解封并清零计数（给改对 token 的攻击者一个全新窗口）。
                drop(entry);
                self.inner.remove(&ip);
                true
            }
            None => true,
        }
    }

    /// 记一次鉴权失败；达阈值即进入封禁窗口。
    pub fn record_failure(&self, ip: IpAddr) {
        if !self.enabled.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let threshold = self.threshold.load(std::sync::atomic::Ordering::Relaxed);
        let window =
            Duration::from_secs(self.window.load(std::sync::atomic::Ordering::Relaxed) * 60);
        let now = Instant::now();
        let mut entry = self.inner.entry(ip).or_insert(Entry {
            fails: 0,
            banned_until: None,
            last_fail: now,
        });
        // 上次失败距今太久：视为新一轮尝试，计数重置（避免极低频慢扫也被累计）。
        if now.duration_since(entry.last_fail) > window {
            entry.fails = 0;
        }
        entry.last_fail = now;
        entry.fails += 1;
        if entry.fails >= threshold {
            entry.banned_until = Some(now + window);
        }
    }

    /// 认证成功：清除该 IP 记录。
    pub fn record_success(&self, ip: IpAddr) {
        self.inner.remove(&ip);
    }

    /// 当前封禁中的 IP 数（治理页展示用，暂未接线）。
    #[allow(dead_code)]
    pub fn banned_count(&self) -> usize {
        let now = Instant::now();
        self.inner
            .iter()
            .filter(|e| e.banned_until.is_some_and(|u| now < u))
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg() -> BanRegistry {
        BanRegistry::new(true, 3, 1) // 阈值 3，窗口 1 分钟
    }

    #[test]
    fn below_threshold_passes() {
        let b = reg();
        let ip: IpAddr = "203.0.113.7".parse().unwrap();
        assert!(b.check(ip));
        b.record_failure(ip);
        b.record_failure(ip);
        assert!(b.check(ip), "未达阈值应放行");
    }

    #[test]
    fn reaching_threshold_bans_then_expires() {
        let b = reg();
        let ip: IpAddr = "203.0.113.8".parse().unwrap();
        for _ in 0..3 {
            b.record_failure(ip);
        }
        assert!(!b.check(ip), "达阈值应封禁");
        assert_eq!(b.banned_count(), 1);

        // 窗口过期：把 last_fail 拨回 2 分钟前，封禁到期 → 解封放行。
        b.inner.get_mut(&ip).unwrap().banned_until = Some(Instant::now() - Duration::from_secs(60));
        assert!(b.check(ip), "封禁窗口过期应解封");
        assert!(b.banned_count() == 0);
    }

    #[test]
    fn success_clears_count() {
        let b = reg();
        let ip: IpAddr = "203.0.113.9".parse().unwrap();
        b.record_failure(ip);
        b.record_failure(ip);
        b.record_success(ip);
        b.record_failure(ip); // 清零后仅 1 次
        assert!(b.check(ip), "成功后计数应清零");
    }

    #[test]
    fn stale_failures_reset() {
        let b = reg();
        let ip: IpAddr = "203.0.113.10".parse().unwrap();
        b.record_failure(ip);
        b.record_failure(ip);
        // 两次失败拨到窗口之外 → 第三次失败时计数重置再 +1，不应封禁。
        let long_ago = Instant::now() - Duration::from_secs(3600);
        {
            let mut e = b.inner.get_mut(&ip).unwrap();
            e.last_fail = long_ago;
        }
        b.record_failure(ip);
        assert!(b.check(ip), "隔窗失败应重置计数");
    }

    #[test]
    fn disabled_registry_always_passes() {
        let b = BanRegistry::new(false, 1, 1); // 阈值 1：disabled 下即便失败也不封
        let ip: IpAddr = "203.0.113.11".parse().unwrap();
        b.record_failure(ip);
        assert!(b.check(ip));
    }

    #[test]
    fn update_policy_takes_effect() {
        let b = BanRegistry::new(true, 5, 5);
        let ip: IpAddr = "203.0.113.12".parse().unwrap();
        for _ in 0..3 {
            b.record_failure(ip);
        }
        assert!(b.check(ip));
        b.update_policy(true, 3, 1);
        b.record_failure(ip);
        assert!(!b.check(ip), "热更新阈值后应立即按新阈值判定");
    }

    #[test]
    fn per_ip_isolation() {
        let b = reg();
        let a: IpAddr = "203.0.113.13".parse().unwrap();
        let c: IpAddr = "203.0.113.14".parse().unwrap();
        for _ in 0..3 {
            b.record_failure(a);
        }
        assert!(!b.check(a));
        assert!(b.check(c), "封禁必须按 IP 隔离");
    }
}
