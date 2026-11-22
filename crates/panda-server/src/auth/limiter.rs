//! In-memory sliding-window rate limiter for login-like endpoints.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Default)]
pub(crate) struct RateLimiter {
    hits: Mutex<HashMap<String, VecDeque<Instant>>>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Limit {
    pub max: usize,
    pub window: Duration,
}

impl Limit {
    pub(crate) const fn per_minutes(max: usize, minutes: u64) -> Self {
        Self { max, window: Duration::from_secs(minutes * 60) }
    }
}

impl RateLimiter {
    /// Record an attempt. `Err(retry_after_secs)` once the key exceeds its limit.
    pub(crate) fn hit(&self, key: &str, limit: Limit) -> Result<(), u64> {
        let now = Instant::now();
        let mut map = self.hits.lock().expect("limiter lock poisoned");
        // Keep memory bounded: drop idle keys occasionally.
        if map.len() > 10_000 {
            map.retain(|_, q| q.back().is_some_and(|t| now.duration_since(*t) < limit.window));
        }
        let q = map.entry(key.to_string()).or_default();
        while q.front().is_some_and(|t| now.duration_since(*t) >= limit.window) {
            q.pop_front();
        }
        if q.len() >= limit.max {
            let oldest = *q.front().expect("non-empty");
            return Err(limit.window.saturating_sub(now.duration_since(oldest)).as_secs().max(1));
        }
        q.push_back(now);
        Ok(())
    }

    pub(crate) fn clear(&self, key: &str) {
        self.hits.lock().expect("limiter lock poisoned").remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_limit_and_clears() {
        let l = RateLimiter::default();
        let limit = Limit::per_minutes(3, 15);
        for _ in 0..3 {
            assert!(l.hit("ip:1", limit).is_ok());
        }
        assert!(l.hit("ip:1", limit).is_err());
        assert!(l.hit("ip:2", limit).is_ok(), "keys are independent");
        l.clear("ip:1");
        assert!(l.hit("ip:1", limit).is_ok());
    }
}
