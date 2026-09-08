//! Runtime boundary used by the canonical `spawn_subagents` tool.
//!
//! The tools crate owns request normalization and response formatting. Core
//! injects a per-run implementation that owns agent creation, cancellation,
//! progress forwarding, nesting limits, and isolated conversation state.

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTaskRequest {
    pub description: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denied_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_sections: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunRequest {
    /// Parent stream used by core to route progress and cancellation.
    pub parent_stream_id: String,
    pub tasks: Vec<SubagentTaskRequest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentTaskStatus {
    Completed,
    Failed,
}

impl SubagentTaskStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_cost: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTaskResult {
    pub description: String,
    #[serde(default)]
    pub result: String,
    pub status: SubagentTaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<SubagentTokenUsage>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunResponse {
    #[serde(default)]
    pub results: Vec<SubagentTaskResult>,
}

#[async_trait]
pub trait SubagentRuntime: Send + Sync {
    /// Run all requested tasks concurrently and preserve request order in the
    /// returned results. Task failures belong in `SubagentTaskResult`; return
    /// an error only when the batch itself could not run.
    async fn run_parallel(&self, request: SubagentRunRequest) -> Result<SubagentRunResponse>;
}
