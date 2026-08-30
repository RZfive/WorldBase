//! 长期记忆工具。

use super::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct MemoryAddTool;

#[async_trait]
impl Tool for MemoryAddTool {
    fn name(&self) -> &str {
        "memory_add"
    }
    fn description(&self) -> &str {
        "把值得长期记住的信息写入记忆库（FTS 全文检索）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "content": { "type": "string" },
                "tags": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["content"]
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let content = require_str(&input, "content")?;
        let tags: Vec<String> = input["tags"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let id = services.store.add_memory(content, &tags)?;
        Ok(json!({ "id": id, "stored": true }))
    }
}

pub struct MemorySearchTool;

#[async_trait]
impl Tool for MemorySearchTool {
    fn name(&self) -> &str {
        "memory_search"
    }
    fn description(&self) -> &str {
        "按关键词检索长期记忆"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "limit": { "type": "integer" }
            },
            "required": ["query"]
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let query = require_str(&input, "query")?;
        let limit = input["limit"].as_u64().unwrap_or(10) as u32;
        let hits = services.store.search_memories(query, limit)?;
        Ok(json!({ "hits": hits }))
    }
}

pub struct MemoryDeleteTool;

#[async_trait]
impl Tool for MemoryDeleteTool {
    fn name(&self) -> &str {
        "memory_delete"
    }
    fn description(&self) -> &str {
        "按 id 删除一条长期记忆"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "integer" } },
            "required": ["id"]
        })
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let id = input["id"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("missing id"))?;
        let deleted = services.store.delete_memory(id)?;
        Ok(json!({ "deleted": deleted }))
    }
}
