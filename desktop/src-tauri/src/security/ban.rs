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

/// 封禁表条目硬上限（超过就清扫，见 `gc`）。
///
/// 4096 个来源 IP 已经远超「家里/办公室几台设备」的真实规模；再往上只可能是扫描。
const MAX_ENTRIES: usize = 4096;

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
        if now.saturating_duration_since(entry.last_fail) > window {
            entry.fails = 0;
        }
        entry.last_fail = now;
        entry.fails += 1;
        if entry.fails >= threshold {
            entry.banned_until = Some(now + window);
        }
        drop(entry);
        self.gc(now, window);
    }

    /// 机会式清扫，**把表的大小钉在上限内**（审查 P2）。
    ///
    /// 🔴 为什么必须有：这张表原来只增不减——`check` 只在「封禁窗口刚好过期且该 IP
    /// 又来请求」时删条目，`record_success` 只在猜对 token 时删。换源扫描
    /// （每次来自新 IP、每次只错一次）能让 DashMap 无界增长，而 `get_status` 每 5s
    /// 要全表遍历一次 `recent_failure_ips`——内存和每轮延迟一起涨。
    ///
    /// 两级：先丢「窗口外且没在封禁中」的过期条目（真正的垃圾）；
    /// 若清完仍超上限，说明是真实的广源扫描，再丢**未封禁**的纯计数条目
    /// （代价是那些 IP 的失败数重新计——它们的封禁本来就没生效，不损失保护强度）。
    fn gc(&self, now: Instant, window: Duration) {
        if self.inner.len() <= MAX_ENTRIES {
            return;
        }
        self.inner.retain(|_, e| {
            e.banned_until.is_some_and(|u| now < u)
                || now.saturating_duration_since(e.last_fail) <= window
        });
        if self.inner.len() > MAX_ENTRIES {
            self.inner
                .retain(|_, e| e.banned_until.is_some_and(|u| now < u));
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

    /// 近期（`within` 内仍有失败记录的）鉴权失败来源 IP 列表（只读快照）。
    ///
    /// 批3-1 多设备「令牌失效」证据：远端 AI 工具带着旧令牌连接时，每次请求都会
    /// 走 `record_failure`（401 记账带 `last_fail` 时间戳），且成功后 `record_success`
    /// 会清掉记录——所以「窗口内仍有失败记录」天然等价于「问题还没解决」，无需额外状态。
    /// 消费方（get_status）自己决定窗口与展示；封禁开关关闭时（127.0.0.1 绑定）
    /// `record_failure` 本就不记账，这里恒为空，前端自动退回启发式文案。
    pub fn recent_failure_ips(&self, within: Duration) -> Vec<IpAddr> {
        let now = Instant::now();
        self.inner
            .iter()
            .filter(|e| now.duration_since(e.last_fail) <= within)
            .map(|e| *e.key())
            .collect()
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
        //
        // 🔴 这里减的必须是「略大于窗口」的时长，不能图省事写 3600s：`Instant` 在 Windows 上
        // 以**系统启动**为原点，`Instant::now() - 3600s` 在开机不满 1 小时的机器上会
        // 直接 panic（`overflow when subtracting duration from instant`）——
        // 测试挂在本机环境而不是被测逻辑上。窗口是 1 分钟（见 `reg()`），拨 2 分钟
        // 就足够落在窗口外，且与相邻用例 `reaching_threshold_bans_then_expires` 的
        // 60s 保持同一量级（那个用例只需要开机满 1 分钟）。
        let long_ago = Instant::now() - Duration::from_secs(120);
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

    /// 批3-1：近期失败来源查询——多设备「令牌失效」证据的数据源语义。
    #[test]
    fn recent_failure_ips_window_and_success_clear() {
        let b = reg();
        let ip: IpAddr = "203.0.113.15".parse().unwrap();
        assert!(b.recent_failure_ips(Duration::from_secs(60)).is_empty());

        b.record_failure(ip);
        let recent = b.recent_failure_ips(Duration::from_secs(60));
        assert_eq!(recent, vec![ip], "窗口内的失败来源应被列出");

        // 窗口为 0：任何已流逝的时间都超出窗口 → 过滤生效（时间推进不可注入，用零窗口代替）。
        assert!(b.recent_failure_ips(Duration::ZERO).is_empty());

        // 认证成功清记录 → 证据消失（问题已解决，不应再展示「令牌失效」）。
        b.record_success(ip);
        assert!(b.recent_failure_ips(Duration::from_secs(60)).is_empty());
    }

    /// 封禁开关关闭时（127.0.0.1 绑定场景）不记账 → 证据恒空，前端退回启发式文案。
    #[test]
    fn recent_failure_ips_empty_when_disabled() {
        let b = BanRegistry::new(false, 1, 1);
        let ip: IpAddr = "203.0.113.16".parse().unwrap();
        b.record_failure(ip);
        assert!(b.recent_failure_ips(Duration::from_secs(60)).is_empty());
    }

    /// 回归：换源扫描不能让封禁表无界增长（原来是只增不减，`get_status` 每 5s 全表遍历）。
    #[test]
    fn table_stays_bounded_under_wide_scan() {
        let b = reg();
        let bad: IpAddr = "203.0.113.99".parse().unwrap();
        let scan = |from: u32| {
            // 阈值 3 + 每源只错一次 ⇒ 全是「未封禁的纯计数条目」，正是最坏情形。
            for n in from..(from + MAX_ENTRIES as u32 * 3) {
                b.record_failure(IpAddr::V4(std::net::Ipv4Addr::from(n)));
            }
        };

        scan(0);
        assert!(
            b.inner.len() <= MAX_ENTRIES,
            "封禁表必须被钉在上限内，实际 {}",
            b.inner.len()
        );

        // 清扫不能把「已经封禁中」的条目丢掉——那才是真正在起作用的保护。
        for _ in 0..3 {
            b.record_failure(bad);
        }
        assert!(!b.check(bad), "达阈值的来源应被封禁");

        scan(MAX_ENTRIES as u32 * 3); // 再来一轮扫描
        assert!(b.inner.len() <= MAX_ENTRIES, "第二轮扫描后仍须在上限内");
        assert!(!b.check(bad), "仍在封禁窗口内的 IP 不能被清扫掉");
    }
}
