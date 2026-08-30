//! Native group-collaboration tools.
//!
//! The tools stay in `worldbase-tools`, while the session/runtime ownership
//! remains in `worldbase-core`. This trait boundary prevents the tool crate
//! from depending on the core dispatcher and keeps ordinary chats free of
//! group-only state.

use crate::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

#[async_trait]
pub trait GroupCollaborationRuntime: Send + Sync {
    async fn message_agent(&self, target_agent_id: &str, message: &str) -> Result<String>;
    async fn read_board(&self) -> Result<Value>;
    async fn update_board(
        &self,
        field: &str,
        op: &str,
        payload: Value,
        reason: Option<&str>,
    ) -> Result<Value>;
    async fn reply_to_user(&self, content: &str) -> Result<Value>;
}

fn runtime(services: &ToolServices) -> Result<&Arc<dyn GroupCollaborationRuntime>> {
    services.group_collaboration.as_ref().ok_or_else(|| {
        anyhow::anyhow!("group collaboration is unavailable outside a native group member run")
    })
}

pub struct MessageAgentTool;

#[async_trait]
impl Tool for MessageAgentTool {
    fn name(&self) -> &str {
        "message_agent"
    }

    fn description(&self) -> &str {
        "向当前群组中的另一位成员发起同步咨询并等待其 Rust 原生回复。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "target_agent_id": { "type": "string", "description": "群组成员的 durable agent ID" },
                "message": { "type": "string", "description": "具体、自包含的问题或请求" }
            },
            "required": ["target_agent_id", "message"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let target_agent_id = require_str(&input, "target_agent_id")?.trim();
        let message = require_str(&input, "message")?.trim();
        if target_agent_id.is_empty() {
            anyhow::bail!("target_agent_id is required");
        }
        if message.is_empty() {
            anyhow::bail!("message is required");
        }
        match runtime(services)?
            .message_agent(target_agent_id, message)
            .await
        {
            Ok(reply) => Ok(json!({ "status": "completed", "reply": reply })),
            Err(error) => Ok(json!({ "status": "failed", "error": error.to_string() })),
        }
    }
}

pub struct ReadBoardTool;

#[async_trait]
impl Tool for ReadBoardTool {
    fn name(&self) -> &str {
        "read_board"
    }

    fn description(&self) -> &str {
        "读取当前 Rust 原生群组共享黑板。"
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, services: &ToolServices) -> Result<Value> {
        Ok(json!({ "board": runtime(services)?.read_board().await? }))
    }
}

pub struct UpdateBoardTool;

#[async_trait]
impl Tool for UpdateBoardTool {
    fn name(&self) -> &str {
        "update_board"
    }

    fn description(&self) -> &str {
        "更新 Rust 原生群组黑板并记录可审计的字段级变更。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "field": { "type": "string", "enum": ["goal", "assumptions", "tasks", "decisions", "evidenceRefs", "openQuestions"] },
                "op": { "type": "string", "enum": ["set", "add", "update", "remove"] },
                "payload": { "description": "字符串列表或结构化任务对象，取决于 field/op" },
                "reason": { "type": "string" }
            },
            "required": ["field", "op", "payload"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let field = require_str(&input, "field")?.trim();
        let op = require_str(&input, "op")?.trim();
        let payload = input
            .get("payload")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("payload is required"))?;
        let reason = input.get("reason").and_then(Value::as_str).map(str::trim);
        match runtime(services)?
            .update_board(field, op, payload, reason)
            .await
        {
            Ok(update) => Ok(json!({ "status": "applied", "update": update })),
            Err(error) => Ok(json!({ "status": "failed", "error": error.to_string() })),
        }
    }
}

pub struct ReplyToUserTool;

#[async_trait]
impl Tool for ReplyToUserTool {
    fn name(&self) -> &str {
        "reply_to_user"
    }

    fn description(&self) -> &str {
        "将当前成员的简洁答复直接发布到 Rust 原生群组的用户可见流。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "content": { "type": "string" } },
            "required": ["content"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let content = require_str(&input, "content")?.trim();
        if content.is_empty() {
            anyhow::bail!("content is required");
        }
        match runtime(services)?.reply_to_user(content).await {
            Ok(reply) => Ok(json!({ "status": "posted", "reply": reply })),
            Err(error) => Ok(json!({ "status": "failed", "error": error.to_string() })),
        }
    }
}

/// These tools are intentionally not part of `builtin_tools()`: only a run
/// with a native group runtime may advertise them to a model.
pub fn group_collaboration_tools() -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(MessageAgentTool),
        Arc::new(ReadBoardTool),
        Arc::new(UpdateBoardTool),
        Arc::new(ReplyToUserTool),
    ]
}
