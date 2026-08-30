//! Todo 工具：工作区 `.worldbase/todo.json` 读写。

use super::{Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

fn todo_path(services: &ToolServices) -> std::path::PathBuf {
    services.workspace.join(".worldbase").join("todo.json")
}

pub struct TodoReadTool;

#[async_trait]
impl Tool for TodoReadTool {
    fn name(&self) -> &str {
        "todo_read"
    }
    fn description(&self) -> &str {
        "读取当前任务的 todo 清单"
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    async fn execute(&self, _input: Value, services: &ToolServices) -> Result<Value> {
        let path = todo_path(services);
        if !path.is_file() {
            return Ok(json!({ "todos": [] }));
        }
        let raw = tokio::fs::read_to_string(&path).await?;
        let todos: Value = serde_json::from_str(&raw).unwrap_or(json!([]));
        Ok(json!({ "todos": todos }))
    }
}

pub struct TodoWriteTool;

#[async_trait]
impl Tool for TodoWriteTool {
    fn name(&self) -> &str {
        "todo_write"
    }
    fn description(&self) -> &str {
        "写入 todo 清单（数组，元素含 content/status/priority）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "todos": { "type": "array", "items": { "type": "object" } }
            },
            "required": ["todos"]
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let todos = input.get("todos").cloned().unwrap_or_else(|| json!([]));
        let path = todo_path(services);
        tokio::fs::create_dir_all(path.parent().unwrap()).await?;
        tokio::fs::write(&path, serde_json::to_string_pretty(&todos)?).await?;
        Ok(json!({ "count": todos.as_array().map(|a| a.len()).unwrap_or(0) }))
    }
}
