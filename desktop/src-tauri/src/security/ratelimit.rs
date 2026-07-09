use std::time::Instant;

use dashmap::DashMap;

pub struct RateLimiter {
    windows: DashMap<String, Vec<Instant>>,
    max_requests: u32,
    window_ms: u64,
}

impl RateLimiter {
    pub fn new(max_requests: u32, window_ms: u64) -> Self {
        Self {
            windows: DashMap::new(),
            max_requests,
            window_ms,
        }
    }

    pub fn check(&self, ip: &str) -> Result<(), String> {
        let now = Instant::now();
        let window_duration = std::time::Duration::from_millis(self.window_ms);

        let mut entry = self.windows.entry(ip.to_string()).or_default();
        let timestamps = entry.value_mut();

        // Remove expired entries
        timestamps.retain(|t| now.duration_since(*t) < window_duration);

        if timestamps.len() >= self.max_requests as usize {
            return Err(format!(
                "Rate limit exceeded: {} requests in {}ms window",
                self.max_requests, self.window_ms
            ));
        }

        timestamps.push(now);
        Ok(())
    }

    pub fn update_limits(&mut self, max_requests: u32, window_ms: u64) {
        self.max_requests = max_requests;
        self.window_ms = window_ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_allows_within_limit() {
        let limiter = RateLimiter::new(3, 60000);
        assert!(limiter.check("127.0.0.1").is_ok());
        assert!(limiter.check("127.0.0.1").is_ok());
        assert!(limiter.check("127.0.0.1").is_ok());
    }

    #[test]
    fn test_blocks_over_limit() {
        let limiter = RateLimiter::new(2, 60000);
        assert!(limiter.check("127.0.0.1").is_ok());
        assert!(limiter.check("127.0.0.1").is_ok());
        assert!(limiter.check("127.0.0.1").is_err());
    }

    #[test]
    fn test_separate_ips() {
        let limiter = RateLimiter::new(1, 60000);
        assert!(limiter.check("10.0.0.1").is_ok());
        assert!(limiter.check("10.0.0.2").is_ok());
    }
}
