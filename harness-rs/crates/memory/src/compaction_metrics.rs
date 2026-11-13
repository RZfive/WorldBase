use serde::{Deserialize, Serialize};

/// One completed compaction attempt, scoped to a conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionMetricRecord {
    pub id: i64,
    pub conversation_id: String,
    pub reason: String,
    pub before_tokens: u64,
    pub after_tokens: u64,
    pub latency_ms: u64,
    /// Whether transcript recovery was used after this compaction before the
    /// next compaction replaced the active checkpoint.
    pub recovery_used: bool,
    pub created_at: String,
}
