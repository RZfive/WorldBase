//! 宿主通道桥：工具 → 宿主反向 RPC 的解耦接口。
//!
//! core 侧实现 `HostChannel`（经事件总线发 host_request、等 host.respond），
//! tools 侧仅依赖本桥，避免反向依赖。

use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

#[async_trait::async_trait]
pub trait HostChannel: Send + Sync {
    async fn request(
        &self,
        stream_id: &str,
        kind: &str,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value>;
}

#[derive(Default)]
pub struct HostBridge {
    inner: std::sync::Mutex<Option<Arc<dyn HostChannel>>>,
}

impl HostBridge {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, channel: Arc<dyn HostChannel>) {
        *self.inner.lock().unwrap() = Some(channel);
    }

    pub async fn request(
        &self,
        stream_id: &str,
        kind: &str,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value> {
        let channel = self
            .inner
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("host channel not available"))?;
        channel.request(stream_id, kind, payload, timeout).await
    }
}
