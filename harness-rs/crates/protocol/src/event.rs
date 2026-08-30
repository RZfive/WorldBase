//! 流式事件帧：带 seq 的事件通知，支持断线重连按 afterSeq 续传。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 事件通知 method 名。
pub const EVENT_METHOD: &str = "event";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventFrame {
    /// 流 id（chat 流 / 群组会话 / scheduler 运行等共享同一帧格式）。
    pub stream_id: String,
    /// 流内单调递增序号，从 0 开始；宿主据此续传与排序。
    pub seq: u64,
    /// 发出时间（RFC3339）。
    pub ts: String,
    #[serde(flatten)]
    pub kind: EventKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum EventKind {
    /// 流开始。
    Start { model: String },
    /// 用户消息已落库。
    UserMessage { content: String },
    /// 文本增量。
    Delta { text: String },
    /// 发起工具调用。
    ToolCall { call_id: String, name: String, args: Value },
    /// 工具执行完成。
    ToolResult { call_id: String, name: String, content: String, is_error: bool },
    /// 权限询问（宿主需以 chat.respond 应答）。
    PermissionRequest { request_id: String, tool_name: String, args_summary: String },
    /// 本轮完整助手消息（含工具调用记录）。
    AssistantMessage { content: String },
    /// 群组：成员发言。
    GroupMessage { member: String, round: u32, content: String },
    /// 群组：黑板更新。
    BoardUpdate { board: crate::types::GroupBoard },
    /// 图像生成完成（携带条目）。
    ImageReady { entry: crate::types::ImageEntry },
    /// 宿主反向请求（宿主必须以 host.respond 应答）。
    HostRequest { request_id: String, request_kind: String, payload: serde_json::Value },
    /// 通知类（后台任务、scheduler 触发等）。
    Notice { text: String },
    /// 流正常结束。
    Done { stop_reason: String },
    /// 流失败。
    Error { message: String },
}

impl EventKind {
    pub fn type_name(&self) -> &'static str {
        match self {
            EventKind::Start { .. } => "start",
            EventKind::UserMessage { .. } => "user_message",
            EventKind::Delta { .. } => "delta",
            EventKind::ToolCall { .. } => "tool_call",
            EventKind::ToolResult { .. } => "tool_result",
            EventKind::PermissionRequest { .. } => "permission_request",
            EventKind::AssistantMessage { .. } => "assistant_message",
            EventKind::GroupMessage { .. } => "group_message",
            EventKind::BoardUpdate { .. } => "board_update",
            EventKind::ImageReady { .. } => "image_ready",
            EventKind::HostRequest { .. } => "host_request",
            EventKind::Notice { .. } => "notice",
            EventKind::Done { .. } => "done",
            EventKind::Error { .. } => "error",
        }
    }
}

/// 有序事件总线：每个 stream 一个 Vec 缓冲 + 每条连接/订阅者的分发通道。
#[derive(Default)]
pub struct EventBuffer {
    frames: Vec<EventFrame>,
    next_seq: u64,
}

impl EventBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// 追加事件，返回分配的 seq。
    pub fn push(&mut self, stream_id: &str, kind: EventKind) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.frames.push(EventFrame {
            stream_id: stream_id.to_string(),
            seq,
            ts: now_rfc3339(),
            kind,
        });
        seq
    }

    /// afterSeq 之后的所有事件（不含 afterSeq 本身；传 -1 表示全量）。
    pub fn after(&self, after_seq: i64) -> Vec<EventFrame> {
        self.frames
            .iter()
            .filter(|f| (f.seq as i64) > after_seq)
            .cloned()
            .collect()
    }

    pub fn all(&self) -> &[EventFrame] {
        &self.frames
    }
}

/// 单流事件订阅者：可复播 + 增量。core 的事件总线按 stream_id 维护。
pub struct StreamChannel {
    pub buffer: tokio::sync::Mutex<EventBuffer>,
    pub tx: tokio::sync::broadcast::Sender<EventFrame>,
}

impl StreamChannel {
    pub fn new() -> Self {
        let (tx, _rx) = tokio::sync::broadcast::channel(1024);
        Self { buffer: tokio::sync::Mutex::new(EventBuffer::new()), tx }
    }

    pub async fn publish(&self, stream_id: &str, kind: EventKind) -> u64 {
        let seq = {
            let mut buf = self.buffer.lock().await;
            buf.push(stream_id, kind.clone())
        };
        let _ = self.tx.send(EventFrame { stream_id: stream_id.into(), seq, ts: now_rfc3339(), kind });
        seq
    }

    pub async fn replay(&self, after_seq: i64) -> Vec<EventFrame> {
        self.buffer.lock().await.after(after_seq)
    }
}

impl Default for StreamChannel {
    fn default() -> Self {
        Self::new()
    }
}

pub fn now_rfc3339() -> String {
    // 避免在 protocol 引入 chrono：用 std 时间手工格式化 RFC3339 (UTC)。
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_utc_secs(secs)
}

pub fn format_utc_secs(secs: u64) -> String {
    // 简单的 UTC 格式化，避免 protocol 依赖 chrono。
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days as i64);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

// Howard Hinnant civil_from_days 算法。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seq_monotonic_and_replay() {
        let mut buf = EventBuffer::new();
        assert_eq!(buf.push("s", EventKind::Start { model: "m".into() }), 0);
        assert_eq!(buf.push("s", EventKind::Delta { text: "a".into() }), 1);
        assert_eq!(buf.push("s", EventKind::Done { stop_reason: "end".into() }), 2);
        let replay = buf.after(1);
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].seq, 2);
    }

    #[test]
    fn utc_format() {
        assert_eq!(format_utc_secs(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc_secs(1_750_000_000), "2025-06-15T15:06:40Z");
    }
}
